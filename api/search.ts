// hunterCard Search API
// @deprecated — search is handled client-side in SearchResultsScreen.tsx, which
// fetches /data/database.json directly and runs the same matching/mapping logic
// in JS. This file is kept for reference but no longer called by the frontend.

import fs from 'fs';
import path from 'path';
import { toNodeHandler } from './_lib/node-adapter';

const SERIES_NAMES: Record<string, string> = {
  hBP01: 'ブルーミングレディアンス', hBP02: 'クインテットスペクトラム',
  hBP03: 'サバイバル・オブ・ザ・フェイビアス',
  hBP04: 'キュリアスユニバース', hBP05: 'エンチャントレガリア',
  hBP06: 'アヤカシヴァーミリオン', hBP07: 'ディーヴァフィーバー',
  hSD01: 'スターターデッキ ときのそら', hSD02: 'スターターデッキ 白上フブキ',
  hSD03: 'スターターデッキ 湊あくあ', hSD04: 'スターターデッキ 天音かなた',
  hSD05: 'スターターデッキ ReGLOSS', hSD06: 'スターターデッキ 風真いろは',
  hSD07: 'スターターデッキ 癒月ちょこ',
  hPR: 'Promo', hBD24: 'Bandai Distribution 2024', hY: 'Yokohama Promo',
};
const COLOR_MAP: Record<string, string> = {
  white: '白色', blue: '藍色', green: '綠色', red: '紅色',
  purple: '紫色', yellow: '黃色', colorless: '無色',
};
const GRADE_RARITY: Record<string, string> = { debut: 'C', '1st': 'U', '2nd': 'R', buzz: 'SR', spot: 'N' };

// Lazy async init — load database.json on first request, not at module load time
let databaseInitPromise: Promise<void> | null = null;
let database: any = { cards: {}, totalCards: 0, lastUpdated: '' };

async function initDatabase(): Promise<void> {
  if (databaseInitPromise) return databaseInitPromise;
  databaseInitPromise = (async () => {
    try {
      // Try resolving relative to api/ dir first (Vercel bundle), fall back to process.cwd()
      const candidates = [
        path.resolve(__dirname, '..', 'data', 'database.json'),
        path.resolve(process.cwd(), 'data', 'database.json'),
      ];
      for (const dbPath of candidates) {
        if (fs.existsSync(dbPath)) {
          const raw = await fs.promises.readFile(dbPath, 'utf-8');
          database = JSON.parse(raw);
          console.log(`[search-api] Loaded database: ${database.totalCards} cards, updated ${database.lastUpdated}`);
          return;
        }
      }
      console.warn(`[search-api] database.json not found (tried: ${candidates.join(', ')})`);
    } catch (e: any) {
      console.error('[search-api] Failed to load database:', e.message);
    }
  })();
  return databaseInitPromise;
}

export const config = { runtime: 'nodejs' };

async function webHandler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' },
    });
  }

  try {
    // Ensure database is loaded before handling the request
    await initDatabase();

    const url = new URL(req.url);
    const q = url.searchParams.get('q');
    if (!q) {
      return Response.json({ error: 'Missing q param' }, {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    const searchQ = q.toLowerCase().trim();
    const cards = database.cards || {};

    // Color search mapping
    const COLOR_TO_CN: Record<string, string[]> = {
      'white': ['白色'],
      'blue': ['藍色', '青色'],
      'green': ['綠色'],
      'red': ['紅色'],
      'purple': ['紫色'],
      'yellow': ['黃色'],
      'colorless': ['無色'],
    };

    const matched = Object.values(cards).filter((c: any) => {
      const id = (c.id || '').toLowerCase();
      const name = (c.name || '').toLowerCase();
      const series = (c.series || '').toLowerCase();
      const type = (c.type || '').toLowerCase();
      const rarity = (c.rarity || '').toLowerCase();
      const color = (c.color || '').toLowerCase();
      const colorCnList = COLOR_TO_CN[color] || [];
      const colorSearch = (color + ' ' + colorCnList.join(' ')).toLowerCase();

      return id.includes(searchQ) ||
             name.includes(searchQ) ||
             series.includes(searchQ) ||
             type.includes(searchQ) ||
             rarity.includes(searchQ) ||
             colorSearch.includes(searchQ);
    });

    const results = matched.map((c: any) => {
      const id = c.id || '';
      const name = c.name || '';
      const rawColor = (c.color || '').toLowerCase();
      const colors = rawColor ? [rawColor] : [];
      const colorNames = colors.map((x: string) => COLOR_MAP[x] || x);
      const series = c.series ? [c.series] : [];
      const seriesNames = series.map((s: any) => SERIES_NAMES[s] || s);

      // Grade/rarity mapping
      let grade = '';
      let rarity = GRADE_RARITY[grade] || 'C';
      const rarityCode = (c.rarity || '').toUpperCase();
      if (rarityCode.includes('OSR') || rarityCode.includes('OUR')) { grade = 'buzz'; rarity = 'SR'; }
      else if (rarityCode === 'UR') { grade = '2nd'; rarity = 'R'; }
      else if (rarityCode === 'SR') { grade = '1st'; rarity = 'U'; }
      else if (rarityCode === 'RR') { grade = 'debut'; rarity = 'C'; }
      else if (rarityCode === 'R') { grade = 'debut'; rarity = 'C'; }
      else if (rarityCode === 'U') { grade = 'debut'; rarity = 'C'; }
      else if (rarityCode === 'C') { grade = 'debut'; rarity = 'C'; }
      else if (rarityCode === 'N') { grade = 'spot'; rarity = 'N'; }

      // Image URL: prefer local, fallback to official
      const imageUrl = c.localImage || c.officialImage || '';

      return {
        id,
        name,
        cardNumber: id,
        type: c.type || '',
        grade,
        rarity,
        colors,
        colorNames,
        series,
        seriesNames,
        imageUrl,
        yuyuPrice: c.sellPrice || null,
        yuyuPriceName: c.yuyuName || '',
        yuyuImage: c.yuyuImage || '',
        officialImage: c.officialImage || '',
        localImage: c.localImage || '',
        effects: c.effects || [],
        hp: c.hp || '',
        life: c.life || '',
        arts: c.arts || '',
        searchKeywords: [c.name || '', '', ''],
        tags: [],
        yuyuUrl: `https://yuyu-tei.jp/top/hocg/?s=${encodeURIComponent(id)}`,
        officialUrl: `https://hololive-official-cardgame.com/cardlist/?keyword=${encodeURIComponent(id)}&view=image`,
      };
    });

    return Response.json({
      query: q,
      total: results.length,
      results,
      dbUpdated: database.lastUpdated,
      dbTotalCards: database.totalCards,
    }, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (e: any) {
    return Response.json({ error: e.message || 'Search failed' }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}

export default toNodeHandler(webHandler);
