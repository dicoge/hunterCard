/**
 * TCG Card Recognition A/B Benchmark Tool
 *
 * Runs a SINGLE pass over a folder of card images and, for EACH image, executes
 * every enabled recognition variant so the same batch is compared apples-to-apples:
 *
 *   - CURRENT_API            → POST the live app pipeline (/api/recognize-card),
 *                              i.e. the current prompt + OpenRouter model + DB match.
 *   - DIRECT_GEMINI_BASELINE → direct Google Gemini with the app's CURRENT line prompt.
 *   - DIRECT_GEMINI_NEW_PROMPT → direct Google Gemini with the NEW JSON-schema prompt.
 *
 * The report breaks success rate / per-field accuracy / latency / errors out per
 * variant (columns), which is the A/B comparison DIC-702 asks for. There is NO
 * direct-OpenRouter variant — the only place OpenRouter appears is INSIDE the
 * CURRENT_API app endpoint, measured here as the baseline we want to beat.
 *
 * Setup:
 * 1. Put test images in data/benchmark/images/   (gitignored — bring your own, non-private)
 * 2. Define expected outputs in data/benchmark/metadata.json (ground truth, committed)
 * 3. Config env:
 *      GEMINI_API_KEY=...          enables the two DIRECT_GEMINI_* variants
 *      BENCHMARK_API_URL=https://holocard-hunter.vercel.app   enables CURRENT_API
 *                                  (set BENCHMARK_API_URL="" to disable it)
 *      BENCHMARK_MODEL=gemini-2.5-flash   (direct-Gemini model, optional)
 * 4. Run: node scripts/benchmark-recognition.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Node 18+ ships a global fetch (WHATWG). No node-fetch dependency needed.
if (typeof fetch !== 'function') {
  console.error('This benchmark needs a global fetch (Node 18+). Please upgrade Node.');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config paths
const BENCHMARK_DIR = path.join(__dirname, '../data/benchmark');
const IMAGES_DIR = path.join(BENCHMARK_DIR, 'images');
const METADATA_FILE = path.join(BENCHMARK_DIR, 'metadata.json');
const REPORT_FILE = path.join(BENCHMARK_DIR, 'report.md');

// ── Config from environment ──
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.BENCHMARK_MODEL || 'gemini-2.5-flash';
// CURRENT_API hits the deployed app pipeline. Defaults to prod; set to "" to skip.
const API_URL = process.env.BENCHMARK_API_URL === undefined
  ? 'https://holocard-hunter.vercel.app'
  : process.env.BENCHMARK_API_URL;

// Fields we can score. Each variant declares which subset it can actually return.
const SCORED_FIELDS = ['cardNumber', 'character', 'rarity', 'hp', 'title'];

// ── NEW prompt: role-based system prompt + native JSON schema ──
const newResponseSchema = {
  type: 'OBJECT',
  properties: {
    cardNumber: { type: 'STRING', description: 'The exact card number printed in small text on the card (usually bottom edge/corner), e.g., "hBP01-001" or "hSD02-005". Lowercase, formatted with dash.' },
    character: { type: 'STRING', description: 'The Japanese name of the character on the card, or "NONE" if not applicable.' },
    rarity: { type: 'STRING', description: 'The rarity letter (C, U, R, SR, SEC, OUR, P), or "NONE" if not applicable.' },
    hp: { type: 'STRING', description: 'The HP value of the card (number only), or "NONE" if not applicable.' },
    title: { type: 'STRING', description: 'The card title/flavor text on the card (in Japanese), or "NONE" if not applicable.' },
    confidence: { type: 'NUMBER', description: 'Confidence rating of the identification between 0.0 (low) and 1.0 (high).' },
    candidates: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { cardNumber: { type: 'STRING' }, name: { type: 'STRING' }, reason: { type: 'STRING' } } },
      description: 'Alternative matching card candidates if the main identification is uncertain.'
    }
  },
  required: ['cardNumber', 'character', 'rarity', 'hp', 'title', 'confidence', 'candidates']
};

const newSystemPrompt = `You are a professional Hololive TCG Card Analyzer. Your task is to identify the card in the image.

Analyze the image carefully:
1. Locate the card number. It is printed in VERY SMALL text at the bottom edge, bottom-left, or bottom-right corner. It always follows formats like: "hBP01-001", "hSD02-005", "hPR-002", etc.
2. Locate the character name (usually Japanese text at the top of the card).
3. Find the HP value in the top-right corner (e.g. 130, 140, 160).
4. Find the Rarity letter (e.g. C, U, R, SR, SEC, OUR, P) near the bottom edge.
5. Identify the Card Title (flavor text or special name, e.g. "ときのそら", "風の赴くままに").
6. If any field is blurred or you are not 100% sure, fill in "NONE" or make a best guess and document in 'candidates'.

Negative Constraints:
- Ignore phone camera UI, hands, tables, or background artifacts.
- Do not hallucinate a card number if the bottom corner is cut off or unreadable. Mark it "NONE" and rely on the character/title instead.

You must return a valid JSON object matching the requested schema. Do not output anything other than JSON.`;

// ── CURRENT prompt: the exact line-based prompt shipped in api/recognize-card.ts ──
const currentLinePrompt = `You are analyzing a Hololive TCG card. Extract info from the card itself (ignore phone UI overlay).

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

// ── Shared helpers ──
function cleanStr(str) {
  if (str === null || str === undefined) return 'none';
  return String(str).toLowerCase().replace(/[^a-z0-9぀-ヿ一-龯-]/g, '').trim() || 'none';
}

async function geminiGenerate(base64Image, mimeType, { prompt, schema }) {
  if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY environment variable.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const generationConfig = { temperature: 0.1 };
  if (schema) { generationConfig.responseMimeType = 'application/json'; generationConfig.responseSchema = schema; }
  const payload = {
    contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: base64Image } }, { text: prompt }] }],
    generationConfig,
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const result = await res.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini API returned no text content.');
  return text.trim();
}

// Parse the CURRENT line-based response into scored fields.
function parseLineResponse(text) {
  const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : 'NONE'; };
  return {
    cardNumber: grab(/CARD_NUMBER:\s*(.+)/i),
    character: grab(/CHARACTER:\s*(.+)/i),
    rarity: grab(/RARITY:\s*(\S+)/i),
    hp: grab(/HP:\s*(\d+)/i),
    title: grab(/TITLE:\s*(.+)/i),
  };
}

// ── Variants ──
// Each variant: { name, fields, enabled, disabledReason?, run(base64, mimeType, dataUri) => {cardNumber,...} }
function buildVariants() {
  const geminiReady = !!GEMINI_API_KEY;
  const apiReady = !!(API_URL && API_URL.trim());
  return [
    {
      name: 'CURRENT_API',
      fields: ['cardNumber', 'character', 'rarity'], // /api/recognize-card returns a DB entry (name/rarity), no hp/title
      enabled: apiReady,
      disabledReason: 'set BENCHMARK_API_URL to the deployed app to enable',
      async run(_b64, _mime, dataUri) {
        const res = await fetch(`${API_URL.replace(/\/$/, '')}/api/recognize-card`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUri }),
        });
        if (!res.ok) throw new Error(`recognize-card HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (!data.success || !data.card) throw new Error(data.error || 'recognize-card returned no card');
        return { cardNumber: data.card.cardNumber, character: data.card.name, rarity: data.card.rarity };
      },
    },
    {
      name: 'DIRECT_GEMINI_BASELINE',
      fields: SCORED_FIELDS,
      enabled: geminiReady,
      disabledReason: 'set GEMINI_API_KEY to enable',
      async run(b64, mime) {
        return parseLineResponse(await geminiGenerate(b64, mime, { prompt: currentLinePrompt }));
      },
    },
    {
      name: 'DIRECT_GEMINI_NEW_PROMPT',
      fields: SCORED_FIELDS,
      enabled: geminiReady,
      disabledReason: 'set GEMINI_API_KEY to enable',
      async run(b64, mime) {
        return JSON.parse(await geminiGenerate(b64, mime, { prompt: newSystemPrompt, schema: newResponseSchema }));
      },
    },
  ];
}

function emptyStats(fields) {
  const s = { total: 0, success: 0, failures: 0, totalLatency: 0, fieldCorrect: {} };
  for (const f of fields) s.fieldCorrect[f] = 0;
  return s;
}

function ensureScaffold() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  if (!fs.existsSync(METADATA_FILE)) {
    const sample = {
      description: 'HoloHunter TCG Vision Test Dataset (ground truth — bring your own gitignored images)',
      images: [{ filename: 'sample-card-1.jpg', expected: { cardNumber: 'hBP01-001', character: 'ときのそら', rarity: 'OUR', hp: '130', title: 'ときのそら' } }],
    };
    fs.writeFileSync(METADATA_FILE, JSON.stringify(sample, null, 2), 'utf8');
    console.log(`Created sample metadata file: ${METADATA_FILE}`);
  }
}

async function runBenchmark() {
  ensureScaffold();

  const variants = buildVariants();
  const enabled = variants.filter((v) => v.enabled);

  console.log('Starting TCG Card Recognition A/B Benchmark...');
  console.log(`Direct-Gemini model: ${MODEL}`);
  for (const v of variants) {
    console.log(`  variant ${v.name}: ${v.enabled ? 'ENABLED' : `SKIPPED (${v.disabledReason})`}`);
  }
  console.log(`Metadata: ${METADATA_FILE}\n`);

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
  } catch (e) {
    console.error(`Error reading metadata: ${e.message}`);
    process.exit(1);
  }
  const testCases = metadata.images || [];
  if (testCases.length === 0) {
    console.log('No test cases in metadata.json.');
    process.exit(0);
  }

  const statsByVariant = Object.fromEntries(variants.map((v) => [v.name, emptyStats(v.fields)]));
  const perImage = []; // { filename, expected, results: { [variant]: {status, latency, got, matches, error} } }

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const imagePath = path.join(IMAGES_DIR, tc.filename);
    console.log(`[${i + 1}/${testCases.length}] ${tc.filename}`);
    if (!fs.existsSync(imagePath)) {
      console.warn(`  Warning: not found in ${IMAGES_DIR}. Skipping (no variant runs for it).`);
      continue;
    }
    const ext = path.extname(tc.filename).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    const base64Image = fs.readFileSync(imagePath).toString('base64');
    const dataUri = `data:${mimeType};base64,${base64Image}`;
    const expected = tc.expected || {};
    const rowResults = {};

    for (const v of enabled) {
      const stats = statsByVariant[v.name];
      stats.total++;
      const start = Date.now();
      try {
        const got = await v.run(base64Image, mimeType, dataUri);
        const latency = Date.now() - start;
        stats.totalLatency += latency;
        stats.success++;
        const matches = {};
        for (const f of v.fields) {
          const ok = cleanStr(got[f]) === cleanStr(expected[f]);
          matches[f] = ok;
          if (ok) stats.fieldCorrect[f]++;
        }
        rowResults[v.name] = { status: 'SUCCESS', latency, got, matches };
        console.log(`  ${v.name}: ✅ ${latency}ms  ${v.fields.map((f) => `${f}:${matches[f] ? '✓' : '✗'}`).join(' ')}`);
      } catch (e) {
        const latency = Date.now() - start;
        stats.totalLatency += latency;
        stats.failures++;
        rowResults[v.name] = { status: 'FAILED', latency, error: e.message };
        console.error(`  ${v.name}: ❌ ${e.message}`);
      }
    }
    perImage.push({ filename: tc.filename, expected, results: rowResults });
  }

  writeReport({ variants, enabled, statsByVariant, perImage });
}

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) : '0.0'; }

function writeReport({ variants, enabled, statsByVariant, perImage }) {
  const ranImages = perImage.length;

  console.log('\n======================================================');
  console.log('A/B BENCHMARK COMPLETE');
  console.log(`Images with a file present: ${ranImages}`);
  for (const v of enabled) {
    const s = statsByVariant[v.name];
    const avg = s.total > 0 ? (s.totalLatency / s.total).toFixed(0) : 0;
    console.log(`  ${v.name}: run ${s.total}, ok ${s.success}, fail ${s.failures}, avg ${avg}ms, cardNumber ${pct(s.fieldCorrect.cardNumber || 0, s.total)}%`);
  }
  console.log('======================================================\n');

  let md = `# TCG Card Recognition A/B Benchmark Report

**Run date:** ${new Date().toISOString().split('T')[0]}
**Direct-Gemini model:** \`${MODEL}\`
**Images present:** ${ranImages}

> This report is regenerated on every run and is gitignored. If **Images present: 0**,
> no variant executed and every accuracy below is \`0.0% (0/0)\` — supply your own
> (gitignored, non-private) images in \`data/benchmark/images/\` matching
> \`metadata.json\` and re-run. Accuracy figures are only meaningful when Images present > 0.

## Variant configuration

| Variant | Status | Scored fields |
| :--- | :--- | :--- |
`;
  for (const v of variants) {
    md += `| \`${v.name}\` | ${v.enabled ? 'enabled' : `skipped (${v.disabledReason})`} | ${v.fields.join(', ')} |\n`;
  }

  md += `\n## Per-variant summary (same image batch)

| Variant | Run | Success | Failures | Avg latency | Card # | Character | Rarity | HP | Title |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
`;
  for (const v of enabled) {
    const s = statsByVariant[v.name];
    const avg = s.total > 0 ? `${(s.totalLatency / s.total).toFixed(0)} ms` : '-';
    const cell = (f) => (v.fields.includes(f) ? `${pct(s.fieldCorrect[f] || 0, s.total)}% (${s.fieldCorrect[f] || 0}/${s.total})` : 'n/a');
    md += `| \`${v.name}\` | ${s.total} | ${s.success} | ${s.failures} | ${avg} | ${cell('cardNumber')} | ${cell('character')} | ${cell('rarity')} | ${cell('hp')} | ${cell('title')} |\n`;
  }

  md += `\n## Per-image card-number comparison

| Image | Expected Card # | ${enabled.map((v) => v.name).join(' | ')} |
| :--- | :--- | ${enabled.map(() => ':---').join(' | ')} |
`;
  for (const row of perImage) {
    const cells = enabled.map((v) => {
      const r = row.results[v.name];
      if (!r) return '-';
      if (r.status === 'FAILED') return '❌ err';
      const mark = r.matches.cardNumber ? '✓' : '✗';
      return `\`${r.got.cardNumber ?? 'NONE'}\` ${mark}`;
    });
    md += `| ${row.filename} | \`${row.expected.cardNumber ?? 'NONE'}\` | ${cells.join(' | ')} |\n`;
  }

  fs.writeFileSync(REPORT_FILE, md, 'utf8');
  console.log(`Detailed report written to: ${REPORT_FILE}`);
}

runBenchmark();
