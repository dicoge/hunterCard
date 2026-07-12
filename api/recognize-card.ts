/**
 * @version 5
 * recognize-card.ts — Uses OpenRouter Gemini Vision API to identify Hololive TCG cards.
 * @cache-buster 20260623-v1
 * @deploy HoloCard-Hunter
 *
 * Two strategies:
 *   Strat 1: Read the tiny card number (e.g. hBP01-001)
 *   Strat 2: If no card number, identify by card text/character name
 *
 * POST /api/recognize-card
 * Body: { image: "data:image/jpeg;base64,..." }
 */

export const config = { runtime: 'edge' };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-3.1-flash-image';
const DATABASE_URL = 'https://holocard-hunter.vercel.app/data/database.json';

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

// ── Card number extraction ──
const prefixMap: Record<string, string> = {
  np: 'hbp', bp: 'hbp', sd: 'hsd', pr: 'hpr',
  sp: 'hsp', ocg: 'hocg', pc: 'hpc', cs: 'hcs',
  co: 'hco', wf: 'hwf', ys: 'hys', ent: 'hent',
};

function normalizeCardNumber(raw: string): string | null {
  let cleaned = raw.trim().replace(/^['"`\s]+|['"`\s]+$/g, '').replace(/\.$/, '').toLowerCase();
  const m = cleaned.match(/(h?[a-z]{2,3}\d{0,2}[-\s]?\d{1,3})/i);
  if (!m) return null;
  let r = m[1].replace(/[-\s]/g, '-');
  if (!r.includes('-')) r = r.replace(/(\d)(\d{2,3})$/, '$1-$2');
  if (!r.startsWith('h')) {
    const p = r.slice(0, 2), rest = r.slice(2);
    r = (prefixMap[p] || 'h' + p) + rest;
  }
  return r;
}

// ── Name-based search ──
function searchByName(cards: Record<string, any>, keywords: string[]): any {
  let best: any = null;
  let bestScore = 0;

  for (const entry of Object.values(cards) as any[]) {
    const name: string = (entry.name || '').toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (name.includes(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore >= 1 ? best : null;
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
    buyPrice: entry.buyPrice ?? null,
    series: entry.series,
    rarity: entry.rarity,
    imageUrl: entry.officialImage || '',
    prices: entry.prices,
    priceHistory: entry.priceHistory || {},
    ytStats: entry.ytStats ?? null,
  };
}

// ── Main handler ──
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return json({ success: false, error: 'API key not set' }, 500);

  try {
    const body = await req.json();
    const { image } = body;
    if (!image || typeof image !== 'string') return json({ success: false, error: 'Invalid image' }, 400);
    const imageData = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;

    // ── Gemini call: extract ALL card features ──
    const geminiPrompt = `You are analyzing a Hololive TCG card. Extract info from the card itself (ignore phone UI overlay).

Look CAREFULLY for the CARD NUMBER — printed in VERY SMALL text at the BOTTOM EDGE or BOTTOM RIGHT corner. Format is like hBP01-001, hSD13-014, hBP08-024. This is the most important field.

Also find these features printed on the card:
- CHARACTER NAME (e.g. ときのそら, セシリア・イマーグリーン) — usually at top
- HP value (e.g. 160, 170) — in top right corner
- RARITY — letter like C, U, R, S, SR, SEC, OUR, P — often near card number
- BLOOM LEVEL (also called 階級) — text like Spot, Debut, Center, Collaboration — near card type
- CARD TITLE (e.g. 総帥のお仕事, 風の赴くままに) — flavor text on card

IMPORTANT: If you are NOT 100% sure of a field, write NONE for that field.

Reply in this EXACT format (one per line):
CHARACTER: [name or NONE]
HP: [number only or NONE]
RARITY: [rarity letter or NONE]
BLOOM_LEVEL: [level text or NONE]
CARD_NUMBER: [exact card number or NONE]
TITLE: [title or NONE]`;

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
          { role: 'user', content: [
            { type: 'text', text: 'Identify this Hololive TCG card.' },
            { type: 'image_url', image_url: { url: imageData } },
          ]},
        ],
        max_tokens: 150,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(12000), // 12s timeout
    });

    if (!orRes.ok) {
      const err = await orRes.text();
      return json({ success: false, error: `API error (${orRes.status})` }, 502);
    }

    const orData = await orRes.json();
    const reply = (orData?.choices?.[0]?.message?.content || '').trim();
    if (!reply) {
      return json({ success: false, error: '服務回傳空回應', debug: { status: orRes.status, model: MODEL } }, 502);
    }

    // Parse Gemini's response — extract ALL fields
    const cnMatch = reply.match(/CARD_NUMBER:\s*(.+)/i);
    const charMatch = reply.match(/CHARACTER:\s*(.+)/i);
    const titleMatch = reply.match(/TITLE:\s*(.+)/i);
    const hpMatch = reply.match(/HP:\s*(\d+)/i);
    const rarityMatch = reply.match(/RARITY:\s*(\S+)/i);
    const bloomMatch = reply.match(/BLOOM_LEVEL:\s*(.+)/i);

    const cardNumberRaw = cnMatch ? cnMatch[1].trim() : 'NONE';
    const characterName = charMatch ? charMatch[1].trim() : '';
    const cardTitle = titleMatch ? titleMatch[1].trim() : '';
    const geminiHp = hpMatch ? hpMatch[1].trim() : null;
    const geminiRarity = rarityMatch ? rarityMatch[1].trim().toUpperCase() : null;
    const geminiBloom = bloomMatch ? bloomMatch[1].trim().toLowerCase() : null;

    const cards = await getDatabase();

    // ── Try name/character match FIRST (more reliable on blurry phone photos) ──
    if (cards && (characterName || cardTitle)) {
      const searchText = `${characterName} ${cardTitle}`.toLowerCase();
      const keywords = searchText
        .replace(/[（(][^)）]*[)）]/g, '')
        .split(/[\s,，、・]+/)
        .filter(k => k.length >= 2 && !/^\d+$/.test(k));

      let bestEntry: any = null;
      let bestScore = 0;
      const charLower = characterName.toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶー一-龠]/g, '');

      // Helper: tiebreaker bonus using Gemini-extracted features
      const featureBonus = (entry: any): number => {
        let bonus = 0;
        if (geminiHp) {
          const entryHp = (entry.hp || '').toString();
          if (entryHp === geminiHp) bonus += 5;
        }
        if (geminiRarity) {
          const entryRarity = (entry.rarity || '').toUpperCase();
          if (entryRarity === geminiRarity) bonus += 3;
        }
        if (geminiBloom) {
          const entryBloom = (entry.bloomLevel || entry.type || '').toLowerCase();
          if (entryBloom.includes(geminiBloom) || geminiBloom.includes(entryBloom)) bonus += 2;
        }
        return bonus;
      };

      for (const entry of Object.values(cards) as any[]) {
        const name: string = (entry.name || '').toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (name.includes(kw)) score += 1;
        }
        const nameNorm = name.replace(/[^a-z0-9ぁ-んァ-ヶー一-龠]/g, '');
        if (charLower && nameNorm.includes(charLower)) score += 3;
        score += featureBonus(entry);
        if (score > bestScore) { bestScore = score; bestEntry = entry; }
        else if (score === bestScore && bestEntry) {
          const prefix = (entry.cardNumber || '').split('-')[0].toLowerCase();
          const bestPrefix = (bestEntry.cardNumber || '').split('-')[0].toLowerCase();
          const entryIsOriginal = entry.series?.toLowerCase() === prefix;
          const bestIsOriginal = bestEntry.series?.toLowerCase() === bestPrefix;
          if (entryIsOriginal && !bestIsOriginal) { bestEntry = entry; }
          else if (!entryIsOriginal && !bestIsOriginal && entry.series !== 'hpr' && bestEntry.series === 'hpr') {
            bestEntry = entry;
          }
        }
      }

      if (bestEntry && bestScore >= 1) {
        if (cardNumberRaw !== 'NONE' && cardNumberRaw !== '') {
          const exactNum = normalizeCardNumber(cardNumberRaw);
          if (exactNum) {
            const exactMatch = Object.values(cards).find(
              (e: any) => e.cardNumber?.toLowerCase() === exactNum
            );
            if (exactMatch) {
              const exactName = (exactMatch.name || '').toLowerCase();
              const exactNameNorm = exactName.replace(/[^a-z0-9ぁ-んァ-ヶー一-龠]/g, '');
              if (charLower && exactNameNorm.includes(charLower)) {
                return json({ success: true, card: fmt(exactMatch), matchMethod: 'name+number', raw: reply });
              }
            }
          }
        }

        const allV = Object.values(cards).filter((e: any) => e.cardNumber === bestEntry.cardNumber) as any[];
        // Prefer entry matching Gemini-detected rarity
        let best = bestEntry;
        if (geminiRarity) {
          const rarityMatch = allV.find((e: any) => (e.rarity || '').toUpperCase() === geminiRarity);
          if (rarityMatch) best = rarityMatch;
        }
        if (best === bestEntry) {
          best = allV.find((e: any) => {
            const prefix = (e.cardNumber || '').split('-')[0].toLowerCase();
            return e.series?.toLowerCase() === prefix;
          }) || allV.find((e: any) => e.series?.toLowerCase() !== 'hpr') || bestEntry;
        }
        return json({ success: true, card: fmt(best), matchMethod: 'name', raw: reply });
      }
    }

    // ── Try card number match ──
    if (cardNumberRaw !== 'NONE' && cardNumberRaw !== '') {
      const cardNumber = normalizeCardNumber(cardNumberRaw);
      if (cardNumber && cards) {
        const key = Object.keys(cards).find(
          k => (cards[k] as any).cardNumber?.toLowerCase() === cardNumber
        );
        if (key) return json({ success: true, card: fmt(cards[key]), matchMethod: 'number', raw: reply });
      }
    }

    return json({ success: false, error: '無法辨識此卡牌', raw: reply }, 404);
  } catch (e: any) {
    return json({ success: false, error: `Error: ${e.message}` }, 500);
  }
}