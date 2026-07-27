/**
 * @version 6
 * recognize-card.ts — Uses OpenRouter Gemini Vision API to identify Hololive TCG cards.
 * @cache-buster 20260727-v1
 * @deploy HoloCard-Hunter
 *
 * Recognition strategy:
 *   1. Extract structured visual fields from the card image.
 *   2. Rank database candidates by: cardNumber exact > cardNumber fuzzy + visual fields > character/title/HP/rarity.
 *   3. Return candidates + confidence instead of hard-selecting ambiguous low-confidence matches.
 *
 * POST /api/recognize-card
 * Body: { image: "data:image/jpeg;base64,...", images?: ["data:image/jpeg;base64,..."] }
 */

export const config = { runtime: 'edge' };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-3.1-flash-image';
const DATABASE_URL = 'https://holocard-hunter.vercel.app/data/database.json';
const HIGH_CONFIDENCE = 0.82;
const LOW_CONFIDENCE = 0.62;

let dbFetchPromise: Promise<Record<string, any> | null> | null = null;

interface ExtractedFields {
  character: string;
  hp: string;
  rarity: string;
  bloomLevel: string;
  cardNumberRaw: string;
  cardNumber: string | null;
  title: string;
}

interface RankedCandidate {
  card: any;
  confidence: number;
  reason: string;
  score: number;
}

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

// ── Card number extraction ──
const prefixMap: Record<string, string> = {
  np: 'hbp', bp: 'hbp', sd: 'hsd', pr: 'hpr',
  sp: 'hsp', ocg: 'hocg', pc: 'hpc', cs: 'hcs',
  co: 'hco', wf: 'hwf', ys: 'hys', ent: 'hent', bd: 'hbd',
};

function normalizeCardNumber(raw: string): string | null {
  let cleaned = raw
    .trim()
    .replace(/^['"`\s]+|['"`\s]+$/g, '')
    .replace(/NONE|UNKNOWN|null/ig, '')
    .replace(/[‐‑‒–—―−ー~〜～]/g, '-')
    .replace(/[oO〇]/g, '0')
    .replace(/[lI｜]/g, '1')
    .replace(/\.$/, '')
    .toLowerCase();
  const m = cleaned.match(/(h?[a-z]{2,4}\d{0,4}[-\s]?\d{1,3})/i);
  if (!m) return null;
  let r = m[1].replace(/[\s-]+/g, '-').replace(/-$/, '');
  if (!r.includes('-')) r = r.replace(/(\d)(\d{2,3})$/, '$1-$2');
  if (!r.startsWith('h')) {
    const p = r.match(/^([a-z]{2,4})/)?.[1] || '';
    const rest = r.slice(p.length);
    r = (prefixMap[p] || `h${p}`) + rest;
  }
  return r;
}

function normalizedNumber(raw: string): string {
  return (normalizeCardNumber(raw) || raw.toLowerCase()).replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function textNorm(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・･\s,，、。()（）\[\]【】「」『』:：!！?？\-ー]/g, '');
}

function tokenize(text: string): string[] {
  return (text || '')
    .normalize('NFKC')
    .split(/[\s,，、。()（）\[\]【】「」『』:：!！?？・･]+/)
    .map(t => textNorm(t))
    .filter(t => t.length >= 2 && !/^\d+$/.test(t) && t !== 'none');
}

function parseFields(reply: string): ExtractedFields {
  const value = (label: string): string => {
    const m = reply.match(new RegExp(`${label}:\\s*(.+)`, 'i'));
    const v = m ? m[1].trim() : '';
    return /^NONE$/i.test(v) ? '' : v;
  };
  const cardNumberRaw = value('CARD_NUMBER');
  return {
    character: value('CHARACTER'),
    hp: value('HP').replace(/[^0-9]/g, ''),
    rarity: value('RARITY').toUpperCase().replace(/[^A-Z]/g, ''),
    bloomLevel: value('BLOOM_LEVEL'),
    cardNumberRaw,
    cardNumber: cardNumberRaw ? normalizeCardNumber(cardNumberRaw) : null,
    title: value('TITLE'),
  };
}

function fmt(entry: any) {
  // For SEC/highest-rarity cards, use the top price from prices array
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
    imageUrl: entry.officialImage || '',
    prices: entry.prices,
  };
}

function scoreEntry(entry: any, fields: ExtractedFields): RankedCandidate {
  let score = 0;
  const reasons: string[] = [];
  const entryNumber = String(entry.cardNumber || '').toLowerCase();

  if (fields.cardNumber) {
    if (entryNumber === fields.cardNumber) {
      score += 132;
      reasons.push('cardNumber exact');
    } else {
      const a = normalizedNumber(entryNumber);
      const b = normalizedNumber(fields.cardNumber);
      const distance = levenshtein(a, b);
      if (a && b && distance <= 1) {
        score += 86;
        reasons.push('cardNumber fuzzy distance≤1');
      } else if (a && b && distance === 2 && a.slice(0, -3) === b.slice(0, -3)) {
        score += 68;
        reasons.push('cardNumber fuzzy same prefix');
      }
    }
  }

  const haystack = textNorm([
    entry.name,
    entry.nameZh,
    entry.yuyuName,
    entry.skillsJp?.name,
    entry.skillsJp?.cardType,
    entry.skillsZh?.name,
    entry.skillsZh?.cardType,
  ].filter(Boolean).join(' '));

  const character = textNorm(fields.character);
  if (character && haystack.includes(character)) {
    score += 30;
    reasons.push('character');
  }

  const titleTokens = tokenize(fields.title);
  const titleHits = titleTokens.filter(t => haystack.includes(t)).length;
  if (titleHits > 0) {
    score += Math.min(24, titleHits * 8);
    reasons.push('title');
  }

  const characterTokens = tokenize(fields.character);
  const characterHits = characterTokens.filter(t => haystack.includes(t)).length;
  if (characterHits > 0) score += Math.min(16, characterHits * 6);

  if (fields.hp) {
    const hp = String(entry.hp || entry.skillsJp?.hp || '').replace(/[^0-9]/g, '');
    if (hp && hp === fields.hp) {
      score += 12;
      reasons.push('HP');
    }
  }

  if (fields.rarity) {
    const rarity = String(entry.rarity || '').toUpperCase();
    if (rarity === fields.rarity) {
      score += 12;
      reasons.push('rarity');
    }
  }

  if (fields.bloomLevel) {
    const bloom = textNorm(fields.bloomLevel);
    const type = textNorm([entry.type, entry.skillsJp?.cardType, entry.skillsZh?.cardType].filter(Boolean).join(' '));
    if (bloom && (type.includes(bloom) || bloom.includes(type))) {
      score += 6;
      reasons.push('bloom/type');
    }
  }

  // Prefer original set printing over promo/reprint only as a tiebreaker, not as the primary signal.
  const prefix = entryNumber.split('-')[0];
  if (prefix && String(entry.series || '').toLowerCase() === prefix) score += 2;
  if (String(entry.series || '').toLowerCase() === 'hpr') score -= 1;

  const confidence = Math.max(0, Math.min(0.99, score / 150));
  return { card: entry, score, confidence, reason: reasons.join(' + ') || 'weak text overlap' };
}

function rankCandidates(cards: Record<string, any>, fields: ExtractedFields): RankedCandidate[] {
  return (Object.values(cards) as any[])
    .map(entry => scoreEntry(entry, fields))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
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

// ── Main handler ──
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return json({ success: false, error: 'API key not set' }, 500);

  try {
    const body = await req.json();
    const inputImages = Array.isArray(body.images) ? body.images : [body.image];
    const images = inputImages
      .filter((image: unknown): image is string => typeof image === 'string' && image.length > 0)
      .slice(0, 2)
      .map((image: string) => image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`);

    if (images.length === 0) return json({ success: false, error: 'Invalid image' }, 400);

    // ── Gemini call: extract ALL card features ──
    const geminiPrompt = `You are an expert Hololive OFFICIAL CARD GAME identifier. Analyze the uploaded card image(s), not the phone/browser UI overlay.

Priority order:
1. Read CARD_NUMBER first. It is tiny, usually on the bottom edge/bottom-right, near rarity. Examples: hBP01-001, hBP08-024, hSD13-014, hBD24-007, hPR-002. Preserve every letter/digit exactly.
2. If CARD_NUMBER is blurred, use CHARACTER + HP + RARITY + BLOOM_LEVEL/CARD_TYPE + TITLE to disambiguate.
3. If multiple image crops are provided, cross-check them: full-frame gives layout; cropped/hi-res image may preserve bottom text.

Important visual locations:
- CHARACTER is usually near the top/name plate.
- HP is usually top-right and numeric only.
- RARITY is a short code such as C, U, R, RR, SR, SEC, OUR, P near the card number.
- BLOOM_LEVEL/CARD_TYPE may be Spot, Debut, 1st, 2nd, Buzz, Center, Oshi, Support, Event.
- TITLE may be a support/event title or prominent skill/title text.

Do not guess. If a field is uncertain, output NONE. Return only this exact line format:
CHARACTER: [name or NONE]
HP: [number only or NONE]
RARITY: [rarity code or NONE]
BLOOM_LEVEL: [level/type text or NONE]
CARD_NUMBER: [exact card number or NONE]
TITLE: [title or NONE]`;

    const userContent: any[] = [{ type: 'text', text: 'Identify this Hololive OCG card. First read the tiny bottom card number, then verify with character, HP, rarity, and title.' }];
    for (const image of images) userContent.push({ type: 'image_url', image_url: { url: image } });

    const orRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://huntercard-alpha.vercel.app',
        'X-Title': 'HunterCard',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: geminiPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 180,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(16000),
    });

    if (!orRes.ok) {
      return json({ success: false, error: `API error (${orRes.status})` }, 502);
    }

    const orData = await orRes.json();
    const reply = (orData?.choices?.[0]?.message?.content || '').trim();
    if (!reply) {
      return json({ success: false, error: '服務回傳空回應', debug: { status: orRes.status, model: MODEL } }, 502);
    }

    const fields = parseFields(reply);
    const cards = await getDatabase();
    if (!cards) return json({ success: false, error: '資料庫載入失敗', raw: reply }, 502);

    const ranked = rankCandidates(cards, fields);
    const candidates = ranked.map(c => ({ ...fmt(c.card), confidence: c.confidence, reason: c.reason }));
    const best = ranked[0];
    const runnerUp = ranked[1];
    const margin = best && runnerUp ? best.confidence - runnerUp.confidence : best?.confidence || 0;
    const debug = {
      rawModelOutput: reply,
      extracted: fields,
      candidates,
      confidence: best?.confidence || 0,
      reason: best?.reason || 'no ranked candidate',
      model: MODEL,
    };

    if (best && best.confidence >= HIGH_CONFIDENCE && (best.confidence >= 0.94 || margin >= 0.08)) {
      return json({ success: true, card: fmt(best.card), candidates, confidence: best.confidence, reason: best.reason, matchMethod: best.reason, raw: reply, debug });
    }

    if (best && best.confidence >= LOW_CONFIDENCE) {
      return json({ success: false, error: '低信心辨識，請從候選卡選擇', candidates, confidence: best.confidence, reason: best.reason, raw: reply, debug }, 200);
    }

    return json({ success: false, error: '無法辨識此卡牌', candidates, confidence: best?.confidence || 0, reason: best?.reason || 'no candidate above threshold', raw: reply, debug }, 404);
  } catch (e: any) {
    return json({ success: false, error: `Error: ${e.message}` }, 500);
  }
}
