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
  const user = await kv.get<StoredUser>(userKey(identity.userId));
  if (!user) {
    // identity 指向的 user 遺失：以身份重建一個一致的 user record（fail-safe）。
    const rebuilt: StoredUser = {
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
    await kv.set(userKey(identity.userId), rebuilt);
    return rebuilt;
  }

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

  await kv.set(userKey(identity.userId), user);
  return user;
}

/** 以 internal id 讀取權威 user record（找不到回 null）。 */
export async function getUserById(
  deps: UserStoreDeps,
  internalId: string
): Promise<StoredUser | null> {
  return deps.kv.get<StoredUser>(userKey(internalId));
}

/**
 * 帳號刪除：以 internal id 移除該 user 的每一個 provider 身份鍵
 * （auth:identity:{provider}:{subject}）與 user record（auth:user:{id}）。
 *
 * idempotent：user record 不存在時回 { existed:false }，仍嘗試刪 user key（no-op）。
 * 身份鍵取自 user.linkedProviders，逐一刪除，確保 (provider, sub) 映射不再存在——
 * 這正是「返回使用者辨識」的入口，刪掉後同一 Google 帳號再登入會被視為新使用者。
 */
export async function deleteUser(
  deps: UserStoreDeps,
  internalId: string
): Promise<DeleteResult> {
  const { kv } = deps;
  const user = await kv.get<StoredUser>(userKey(internalId));
  if (!user) {
    await kv.del(userKey(internalId));
    return { existed: false, removedIdentities: 0 };
  }

  const identityKeys = user.linkedProviders.map((p) =>
    identityKey(p.provider, p.providerId)
  );
  if (identityKeys.length > 0) {
    await kv.del(...identityKeys);
  }
  await kv.del(userKey(internalId));

  return { existed: true, removedIdentities: identityKeys.length };
}
