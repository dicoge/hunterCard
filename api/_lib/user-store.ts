/**
 * 使用者 / 身份儲存（Vercel KV 版，DIC-665）。
 *
 * 身份主鍵是 `(provider, subject)`，**絕不以 email 為身份依據**——同一 provider 的
 * email 可能變更、不同 provider 可能給不同 email，都不得造成錯誤歸戶。內部使用者
 * 以隨機 UUID 建立；收藏 / 設定 / watchlist / 推播 token 一律以此 internal id 為 owner。
 *
 * KV keys：
 *   auth:identity:{provider}:{subject} → StoredIdentity（含 userId，登入映射入口）
 *   auth:user:{id}                     → StoredUser（含 linkedProviders）
 *
 * 併發保護：建立新使用者時以 SET NX 佔用 identity key；若佔用失敗代表另一併發登入
 * 已先建立同一 (provider, subject)，改讀既有 identity 回相同 internal user——保證
 * 同一 (provider, subject) 永遠對應唯一 internal user，不會因競態產生重複帳號。
 *
 * 依賴以 KVLike 介面注入，單元測試可用純記憶體假實作離線驗證。
 */

export interface KVLike {
  get<T>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    opts?: { nx?: boolean }
  ): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface StoredLinkedProvider {
  provider: string;
  providerId: string;
  email: string | null;
  displayName: string | null;
  photoUrl: string | null;
  linkedAt: string;
}

export interface StoredUser {
  internalId: string;
  displayName: string | null;
  primaryEmail: string | null;
  photoUrl: string | null;
  linkedProviders: StoredLinkedProvider[];
  createdAt: string;
  lastLoginAt: string;
}

interface StoredIdentity {
  userId: string;
  provider: string;
  subject: string;
  email: string | null;
  linkedAt: string;
}

export interface ProviderProfile {
  subject: string;
  email: string | null;
  name: string | null;
  photoUrl: string | null;
}

export interface ResolveResult {
  user: StoredUser;
  isNewUser: boolean;
}

export interface DeleteResult {
  /** 是否存在對應的 user record（false 表示已無資料，視為 idempotent 成功）。 */
  existed: boolean;
  /** 被移除的 provider 身份鍵（auth:identity:{provider}:{subject}）數量。 */
  removedIdentities: number;
}

export interface UserStoreDeps {
  kv: KVLike;
  now?: () => number;
  newId?: () => string;
}

/**
 * returning-user 登入在「讀取身份」與「寫回 user」之間，被一個併發的 `deleteUser`（原子
 * 移除 identity+user）搶先——若此時仍無條件寫回舊 user record，會 resurrect 一個孤兒 user
 * （其身份鍵已消失），下次以同一 (provider, sub) 登入會因找不到身份而建立**第二個** internal
 * user（帳號分裂）。`touchExistingUser` 偵測到此情形時丟出本錯誤，登入端點據此 fail-closed
 * （回可重試的非 2xx，見 login-handler）；使用者重試登入會取得新 token 並乾淨地建立單一新帳號。
 */
export class AccountConcurrentlyDeletedError extends Error {
  constructor(userId: string) {
    super(`account_concurrently_deleted:${userId}`);
    this.name = 'AccountConcurrentlyDeletedError';
  }
}

function identityKey(provider: string, subject: string): string {
  return `auth:identity:${provider}:${subject}`;
}

function userKey(internalId: string): string {
  return `auth:user:${internalId}`;
}

/**
 * login-or-create：以 (provider, subject) 找既有 internal user，沒有則建立新的。
 * returning user 會刷新 lastLoginAt 與該 provider 的 email / 顯示名稱（email 只是
 * 附帶資料，非身份鍵）。
 */
export async function resolveOrCreateUser(
  deps: UserStoreDeps,
  provider: string,
  profile: ProviderProfile
): Promise<ResolveResult> {
  const { kv } = deps;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const nowIso = new Date(now()).toISOString();

  const idKey = identityKey(provider, profile.subject);

  const existingIdentity = await kv.get<StoredIdentity>(idKey);
  if (existingIdentity) {
    return {
      user: await touchExistingUser(kv, existingIdentity, provider, profile, nowIso),
      isNewUser: false,
    };
  }

  const internalId = newId();
  const identity: StoredIdentity = {
    userId: internalId,
    provider,
    subject: profile.subject,
    email: profile.email,
    linkedAt: nowIso,
  };

  // SET NX：只有第一個寫入者成功佔用；失敗表示另一併發登入已建立同一身份。
  const reserved = await kv.set(idKey, identity, { nx: true });
  if (reserved === null || reserved === undefined || reserved === false) {
    const winner = await kv.get<StoredIdentity>(idKey);
    if (winner) {
      return {
        user: await touchExistingUser(kv, winner, provider, profile, nowIso),
        isNewUser: false,
      };
    }
    // 極端情況：佔用失敗卻讀不到贏家，視為錯誤讓端點 fail-closed。
    throw new Error('identity_reservation_inconsistent');
  }

  const user: StoredUser = {
    internalId,
    displayName: profile.name,
    primaryEmail: profile.email,
    photoUrl: profile.photoUrl,
    linkedProviders: [
      {
        provider,
        providerId: profile.subject,
        email: profile.email,
        displayName: profile.name,
        photoUrl: profile.photoUrl,
        linkedAt: nowIso,
      },
    ],
    createdAt: nowIso,
    lastLoginAt: nowIso,
  };
  await kv.set(userKey(internalId), user);
  return { user, isNewUser: true };
}

async function touchExistingUser(
  kv: KVLike,
  identity: StoredIdentity,
  provider: string,
  profile: ProviderProfile,
  nowIso: string
): Promise<StoredUser> {
  const existing = await kv.get<StoredUser>(userKey(identity.userId));
  const record = existing
    ? applyLoginTouch(existing, provider, profile, nowIso)
    : rebuildUser(identity, provider, profile, nowIso);

  // 只有在身份鍵仍存活且仍指向同一 internal user 時才寫回，杜絕與併發刪除的 TOCTOU
  // resurrection / 帳號分裂（見 AccountConcurrentlyDeletedError）。
  const committed = await writeUserIfIdentityLives(kv, identity, record);
  if (!committed) {
    throw new AccountConcurrentlyDeletedError(identity.userId);
  }
  return record;
}

/** returning user：刷新 lastLoginAt 與該 provider 的 email / 顯示名稱（純函式，不觸 KV）。 */
function applyLoginTouch(
  user: StoredUser,
  provider: string,
  profile: ProviderProfile,
  nowIso: string
): StoredUser {
  user.lastLoginAt = nowIso;
  const linked = user.linkedProviders.find(
    (p) => p.provider === provider && p.providerId === profile.subject
  );
  if (linked) {
    linked.email = profile.email;
    if (profile.name) linked.displayName = profile.name;
    if (profile.photoUrl) linked.photoUrl = profile.photoUrl;
  }
  if (!user.displayName && profile.name) user.displayName = profile.name;
  if (!user.photoUrl && profile.photoUrl) user.photoUrl = profile.photoUrl;
  return user;
}

/** identity 指向的 user 遺失時，以身份重建一致的 user record（純函式，不觸 KV）。 */
function rebuildUser(
  identity: StoredIdentity,
  provider: string,
  profile: ProviderProfile,
  nowIso: string
): StoredUser {
  return {
    internalId: identity.userId,
    displayName: profile.name,
    primaryEmail: profile.email,
    photoUrl: profile.photoUrl,
    linkedProviders: [
      {
        provider,
        providerId: profile.subject,
        email: profile.email,
        displayName: profile.name,
        photoUrl: profile.photoUrl,
        linkedAt: identity.linkedAt,
      },
    ],
    createdAt: identity.linkedAt,
    lastLoginAt: nowIso,
  };
}

/**
 * 以身份鍵的存活作為與 `deleteUser` 之間的序列化點（optimistic CAS + 補償）：唯有身份鍵
 * 仍存在且仍指向同一 internal user 時，才寫入 user record。前置檢查後再寫，寫後再驗一次；
 * 若在檢查與寫入之間發生併發刪除（身份鍵已消失或已被新登入取代為別的 user），撤銷剛寫入的
 * user 並回 false，避免留下孤兒。deleteUser 端維持單一原子 DEL，序列化完全落在登入這一側。
 *
 * 各種交錯下的最終持久狀態：
 *   - 刪除發生在前置檢查之前 → 檢查即失敗，不寫入。
 *   - 刪除發生在寫入與後置再驗之間、或再驗之前 → 後置再驗偵測到 → 撤銷剛寫入的 user。
 *   - 刪除發生在後置再驗之後 → 刪除的原子 DEL 會一併移除我們寫入的 user（乾淨，無孤兒）。
 * 無論何者皆不留孤兒 user、不使 (provider, sub) 分裂成第二個帳號。
 */
async function writeUserIfIdentityLives(
  kv: KVLike,
  identity: StoredIdentity,
  record: StoredUser
): Promise<boolean> {
  const idKey = identityKey(identity.provider, identity.subject);

  const before = await kv.get<StoredIdentity>(idKey);
  if (!before || before.userId !== identity.userId) return false;

  await kv.set(userKey(record.internalId), record);

  const after = await kv.get<StoredIdentity>(idKey);
  if (!after || after.userId !== identity.userId) {
    await kv.del(userKey(record.internalId));
    return false;
  }
  return true;
}

/** 以 internal id 讀取權威 user record（找不到回 null）。 */
export async function getUserById(
  deps: UserStoreDeps,
  internalId: string
): Promise<StoredUser | null> {
  return deps.kv.get<StoredUser>(userKey(internalId));
}

/**
 * 帳號刪除：**原子**移除該 user 的權威 write-set——每一個 provider 身份鍵
 * （auth:identity:{provider}:{subject}）與 user record（auth:user:{id}）——於**單一
 * Redis DEL 指令**完成。Redis 單執行緒，多鍵 DEL 為單一原子指令，故不會出現「身份鍵已刪、
 * user 未刪」的中途失敗而在下次登入分裂帳號；整個 DEL 要嘛全成功、要嘛全失敗（可重試）。
 *
 * idempotent 且可重試：DEL 拋錯時所有鍵維持原狀，重跑本函式即可補完（多刪不存在的鍵為 no-op）。
 * user record 不存在時回 { existed:false }，不發任何刪除。刪除後 (provider, sub) 映射消失，
 * 同一 Google 帳號再登入會被視為新使用者。
 */
export async function deleteUser(
  deps: UserStoreDeps,
  internalId: string
): Promise<DeleteResult> {
  const { kv } = deps;
  const user = await kv.get<StoredUser>(userKey(internalId));
  if (!user) {
    return { existed: false, removedIdentities: 0 };
  }

  const identityKeys = user.linkedProviders.map((p) =>
    identityKey(p.provider, p.providerId)
  );
  // 單一原子 DEL：身份鍵 + user key 一起刪，杜絕中途失敗造成的帳號分裂。
  await kv.del(...identityKeys, userKey(internalId));

  return { existed: true, removedIdentities: identityKeys.length };
}
