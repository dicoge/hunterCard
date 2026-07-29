/**
 * @version 6
 * recognize-card.ts — Gemini Vision API + deterministic candidate ranking for Hololive TCG cards.
 *
 * Accepts one or more image data URIs. The web scanner sends both a full-frame image
 * and a scan-area crop so the model can read tiny bottom-edge card numbers without
 * losing whole-card context.
 */

export const config = { runtime: 'edge' };

const GEMINI_MODEL = 'gemini-2.5-flash';
const DATABASE_URL = 'https://holocard-hunter.vercel.app/data/database.json';
const AUTO_ACCEPT_CONFIDENCE = 0.82;

let dbFetchPromise: Promise<Record<string, any> | null> | null = null;

async function getDatabase(): Promise<Record<string, any> | null> {
  if (dbFetchPromise) return dbFetchPromise;
  dbFetchPromise = (async () => {
    try {
      const res = await fetch(DATABASE_URL);
      if (!res.ok) { dbFetchPromise = null; return null; }
      return (await res.json())?.cards || null;
    } catch {
      dbFetchPromise = null;
      return null;
    }
  })();
  return dbFetchPromise;
}

const prefixMap: Record<string, string> = {
  np: 'hbp', bp: 'hbp', sd: 'hsd', pr: 'hpr',
  sp: 'hsp', ocg: 'hocg', pc: 'hpc', cs: 'hcs',
  co: 'hco', wf: 'hwf', ys: 'hys', ent: 'hent', bd: 'hbd',
};

export function normalizeCardNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let cleaned = raw.trim().replace(/^['"`\s]+|['"`\s]+$/g, '').replace(/\.$/, '').toLowerCase();
  if (!cleaned || cleaned === 'none' || cleaned === 'unknown') return null;
  cleaned = cleaned
    .normalize('NFKC')
    .replace(/[oO〇]/g, '0')
    .replace(/[lI｜]/g, '1')
    .replace(/[－‐‑‒–—―−_\s]+/g, '-');
  const m = cleaned.match(/(h?[a-z]{2,3}\d{0,2}-?\d{1,3})/i);
  if (!m) return null;
  let r = m[1].replace(/-+/g, '-');
  if (!r.includes('-')) r = r.replace(/(\d)(\d{2,3})$/, '$1-$2');
  if (!r.startsWith('h')) {
    const p = r.slice(0, 2), rest = r.slice(2);
    r = (prefixMap[p] || 'h' + p) + rest;
  }
  return r;
}

function normalizeText(v: any): string {
  return String(v || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・･\s'"`.,，、:：;；()（）\[\]【】]/g, '')
    .trim();
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function similarity(a: string, b: string): number {
  const x = normalizeText(a), y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(0.95, Math.min(x.length, y.length) / Math.max(x.length, y.length) + 0.25);
  return Math.max(0, 1 - editDistance(x, y) / Math.max(x.length, y.length));
}

function parseField(reply: string, field: string): string {
  const match = reply.match(new RegExp(`^${field}:\\s*(.+)$`, 'im'));
  const value = match ? match[1].trim() : '';
  return /^(none|unknown|n\/a|-)?$/i.test(value) ? '' : value;
}

function fmt(entry: any) {
  let price = entry.sellPrice;
  if (entry.rarity === 'SEC' && entry.prices?.length > 0) {
    price = Math.max(...entry.prices.map((p: any) => p.sellPrice || 0));
  }
  return {
    cardNumber: entry.cardNumber,
    name: entry.name,
    sellPrice: price,
    series: entry.series,
    rarity: entry.rarity,
    imageUrl: entry.officialImage || entry.localImage || '',
    prices: entry.prices,
  };
}

function json(d: any, status = 200): Response {
  return new Response(JSON.stringify(d), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    },
  });
}

function dataUriToGeminiPart(image: string) {
  const match = image.match(/^data:([^;]+);base64,(.+)$/);
  return {
    inline_data: {
      mime_type: match?.[1] || 'image/jpeg',
      data: match?.[2] || image,
    },
  };
}

const visionPrompt = `You are identifying a real Hololive OFFICIAL CARD GAME card from camera photos.

You may receive two images: (1) full card/context and (2) a cropped scan area. Use both. Ignore phone UI overlays, scanner borders, reflections, and background.

Critical reading order:
1. CARD_NUMBER: tiny text near the bottom edge/bottom-right. Examples: hBP01-001, hBP08-024, hSD13-014, hBD24-007. Preserve prefix and digits exactly.
2. CHARACTER: main character/holomem name, usually top area.
3. HP: number in top-right if present.
4. RARITY: C, U, R, RR, S, SR, SEC, OUR, P, etc. near card number.
5. BLOOM_LEVEL / card type: Spot, Debut, 1st, 2nd, Buzz, Oshi, Support, Event, etc.
6. TITLE: card title/support event name, if distinct from character.

If a field is not clearly visible, write NONE. Do not guess missing digits. Return exactly:
CHARACTER: [name or NONE]
HP: [number only or NONE]
RARITY: [rarity or NONE]
BLOOM_LEVEL: [level/type or NONE]
CARD_NUMBER: [exact card number or NONE]
TITLE: [title or NONE]`;

async function callVision(images: string[]): Promise<{ reply: string; provider: string; model: string }> {
  const imageList = images.filter(Boolean).slice(0, 2).map(img => img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`);
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY not set');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: visionPrompt }, ...imageList.map(dataUriToGeminiPart)],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 180 },
    }),
    signal: AbortSignal.timeout(14000),
  });
  if (!res.ok) throw new Error(`Gemini API error (${res.status})`);
  const data = await res.json();
  const reply = (data?.candidates?.[0]?.content?.parts || []).map((part: any) => part.text || '').join('\n').trim();
  return { reply, provider: 'gemini', model: GEMINI_MODEL };
}

export function rankCandidates(cards: Record<string, any>, extracted: any) {
  const entries = Object.values(cards) as any[];
  const normalizedNumber = normalizeCardNumber(extracted.cardNumberRaw);
  const normalizedNumberFlat = normalizedNumber?.replace(/[^a-z0-9]/g, '') || '';
  const character = normalizeText(extracted.characterName);
  const title = normalizeText(extracted.cardTitle);
  const rarity = normalizeText(extracted.rarity).toUpperCase();
  const hp = String(extracted.hp || '').replace(/\D/g, '');
  const bloom = normalizeText(extracted.bloom);

  const ranked = entries.map(entry => {
    let score = 0;
    const reasons: string[] = [];
    const entryNumber = String(entry.cardNumber || '').toLowerCase();
    const entryFlat = entryNumber.replace(/[^a-z0-9]/g, '');
    const entryName = normalizeText(entry.name);
    const entryRarity = normalizeText(entry.rarity).toUpperCase();
    const entryHp = String(entry.hp || '').replace(/\D/g, '');
    const entryBloom = normalizeText(entry.bloomLevel || entry.type || '');

    if (normalizedNumber && entryNumber === normalizedNumber) {
      score += 100; reasons.push('cardNumber exact');
    } else if (normalizedNumberFlat && entryFlat) {
      const distance = editDistance(entryFlat, normalizedNumberFlat);
      if (distance <= 1) { score += 78; reasons.push('cardNumber fuzzy-1'); }
      else if (distance <= 2 && normalizedNumberFlat.length >= 8) { score += 62; reasons.push('cardNumber fuzzy-2'); }
    }

    const charScore = character ? similarity(character, entryName) : 0;
    if (charScore >= 0.9) { score += 26; reasons.push('character exact/contains'); }
    else if (charScore >= 0.55) { score += 14 * charScore; reasons.push('character fuzzy'); }

    const titleScore = title ? similarity(title, entryName) : 0;
    if (titleScore >= 0.9) { score += 18; reasons.push('title exact/contains'); }
    else if (titleScore >= 0.55) { score += 10 * titleScore; reasons.push('title fuzzy'); }

    if (rarity && entryRarity === rarity) { score += 8; reasons.push('rarity'); }
    if (hp && entryHp && entryHp === hp) { score += 8; reasons.push('hp'); }
    if (bloom && entryBloom && (entryBloom.includes(bloom) || bloom.includes(entryBloom))) { score += 5; reasons.push('bloom/type'); }

    const prefix = entryNumber.split('-')[0];
    if (String(entry.series || '').toLowerCase() === prefix) score += 1.5;
    else if (String(entry.series || '').toLowerCase() === 'hpr') score -= 1;

    return { entry, score, reasons };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);

  const topScore = ranked[0]?.score || 0;
  const secondScore = ranked[1]?.score || 0;
  const confidence = Math.max(0, Math.min(0.99, (topScore / 118) * Math.min(1, (topScore - secondScore + 18) / 38)));
  const candidates = ranked.slice(0, 5).map(item => ({
    ...fmt(item.entry),
    confidence: Math.round(Math.max(0.05, Math.min(0.99, item.score / 118)) * 100) / 100,
    reason: item.reasons.join(', '),
    score: Math.round(item.score * 10) / 10,
  }));

  return {
    normalizedCardNumber: normalizedNumber,
    confidence: Math.round(confidence * 100) / 100,
    reason: ranked[0]?.reasons.join(', ') || 'no candidate',
    candidates,
  };
}


// Build a ranked candidate list (top N) from scored entries, deduped by cardNumber.
// Each candidate carries its own confidence relative to the best score so the client
// can show a "top 3-5 候選" picker for mid/low-confidence scans.
function buildCandidates(
  scored: { entry: any; score: number }[],
  topConfidence: number,
  limit = 5,
) {
  const bestScore = scored.length > 0 ? scored[0].score : 0;
  const seen = new Set<string>();
  const out: any[] = [];
  for (const { entry, score } of scored) {
    const key = (entry.cardNumber || entry.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rel = bestScore > 0 ? score / bestScore : 0;
    const confidence = Math.max(0.15, Math.min(topConfidence, rel * topConfidence));
    out.push({ ...fmt(entry), confidence: Math.round(confidence * 100) / 100 });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Main handler ──
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  try {
    const body = await req.json();
    const images = Array.isArray(body.images) ? body.images : [body.image];
    if (!images[0] || typeof images[0] !== 'string') return json({ success: false, error: 'Invalid image' }, 400);

    const [{ reply, provider, model }, cards] = await Promise.all([
      callVision(images),
      getDatabase(),
    ]);
    if (!reply) return json({ success: false, error: '服務回傳空回應', debug: { provider, model } }, 502);
    if (!cards) return json({ success: false, error: '資料庫載入失敗', raw: reply }, 502);

    const extracted = {
      characterName: parseField(reply, 'CHARACTER'),
      hp: parseField(reply, 'HP'),
      rarity: parseField(reply, 'RARITY'),
      bloom: parseField(reply, 'BLOOM_LEVEL'),
      cardNumberRaw: parseField(reply, 'CARD_NUMBER'),
      cardTitle: parseField(reply, 'TITLE'),
    };
    const ranking = rankCandidates(cards, extracted);
    const debug = {
      provider,
      model,
      rawModelOutput: reply,
      extracted,
      normalizedCardNumber: ranking.normalizedCardNumber,
      candidates: ranking.candidates,
      confidence: ranking.confidence,
      reason: ranking.reason,
    };

    if (ranking.candidates.length === 0) {
      return json({ success: false, error: '無法辨識此卡牌', raw: reply, debug, candidates: [] }, 404);
    }

    const best = ranking.candidates[0];
    if (ranking.confidence < AUTO_ACCEPT_CONFIDENCE) {
      return json({
        success: false,
        lowConfidence: true,
        error: '辨識信心不足，請從候選卡中選擇',
        raw: reply,
        candidates: ranking.candidates,
        confidence: ranking.confidence,
        reason: ranking.reason,
        debug,
      }, 200);
    }

    return json({
      success: true,
      card: best,
      matchMethod: ranking.reason,
      confidence: ranking.confidence,
      candidates: ranking.candidates,
      reason: ranking.reason,
      raw: reply,
      debug,
    });
  } catch (e: any) {
    return json({ success: false, error: `Error: ${e.message}` }, /GEMINI_API_KEY not set/.test(e.message) ? 500 : 502);
  }
}
