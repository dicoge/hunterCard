/**
 * TCG Card Recognition Benchmark Tool
 *
 * This script runs multi-modal vision models against a folder of card images,
 * parses structured JSON outputs (card number, character, rarity, HP, title, confidence),
 * and generates a detailed performance report comparing the actual output to the ground truth.
 *
 * Setup:
 * 1. Put test images in data/benchmark/images/
 * 2. Define expected outputs in data/benchmark/metadata.json
 * 3. Set env variables (GEMINI_API_KEY or OPENROUTER_API_KEY)
 * 4. Run: node scripts/benchmark-recognition.js
 */

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config paths
const BENCHMARK_DIR = path.join(__dirname, '../data/benchmark');
const IMAGES_DIR = path.join(BENCHMARK_DIR, 'images');
const METADATA_FILE = path.join(BENCHMARK_DIR, 'metadata.json');
const REPORT_FILE = path.join(BENCHMARK_DIR, 'report.md');

// Options from environment
const PROVIDER = process.env.PROVIDER || 'GEMINI'; // 'GEMINI' or 'OPENROUTER'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.BENCHMARK_MODEL || (PROVIDER === 'GEMINI' ? 'gemini-2.5-flash' : 'google/gemini-flash-1.5');

// JSON schema for card recognition
const responseSchema = {
  type: 'OBJECT',
  properties: {
    cardNumber: {
      type: 'STRING',
      description: 'The exact card number printed in small text on the card (usually bottom edge/corner), e.g., "hBP01-001" or "hSD02-005". Lowercase, formatted with dash.'
    },
    character: {
      type: 'STRING',
      description: 'The Japanese name of the character on the card, or "NONE" if not applicable.'
    },
    rarity: {
      type: 'STRING',
      description: 'The rarity letter (C, U, R, SR, SEC, OUR, P), or "NONE" if not applicable.'
    },
    hp: {
      type: 'STRING',
      description: 'The HP value of the card (number only), or "NONE" if not applicable.'
    },
    title: {
      type: 'STRING',
      description: 'The card title/flavor text on the card (in Japanese), or "NONE" if not applicable.'
    },
    confidence: {
      type: 'NUMBER',
      description: 'Confidence rating of the identification between 0.0 (low) and 1.0 (high).'
    },
    candidates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          cardNumber: { type: 'STRING' },
          name: { type: 'STRING' },
          reason: { type: 'STRING' }
        }
      },
      description: 'Alternative matching card candidates if the main identification is uncertain.'
    }
  },
  required: ['cardNumber', 'character', 'rarity', 'hp', 'title', 'confidence', 'candidates']
};

const systemPrompt = `You are a professional Hololive TCG Card Analyzer. Your task is to identify the card in the image.

Analyze the image carefully:
1. Locate the card number. It is printed in VERY SMALL text at the bottom edge, bottom-left, or bottom-right corner. It always follows formats like: "hBP01-001", "hSD02-005", "hPR-002", etc.
2. Locate the character name (usually Japanese text at the top of the card).
3. Find the HP value in the top-right corner (e.g. 130, 140, 160).
4. Find the Rarity letter (e.g. C, U, R, SR, SEC, OUR, P) near the bottom edge.
5. Identify the Card Title (flavor text or special name, e.g. "ときのそら", "風 of 赴くままに").
6. If any field is blurred or you are not 100% sure, fill in "NONE" or make a best guess and document in 'candidates'.

You must return a valid JSON object matching the requested schema. Do not output anything other than JSON.`;

// Setup directories and example files if they don't exist
function ensureDirectories() {
  if (!fs.existsSync(BENCHMARK_DIR)) {
    fs.mkdirSync(BENCHMARK_DIR, { recursive: true });
    console.log(`Created benchmark directory: ${BENCHMARK_DIR}`);
  }
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    console.log(`Created benchmark images directory: ${IMAGES_DIR}`);
  }

  if (!fs.existsSync(METADATA_FILE)) {
    const sampleMetadata = {
      description: "TCG Card Vision Benchmark Metadata",
      images: [
        {
          filename: "sample-card-1.jpg",
          expected: {
            cardNumber: "hBP01-001",
            character: "ときのそら",
            rarity: "OUR",
            hp: "130",
            title: "ときのそら"
          }
        }
      ]
    };
    fs.writeFileSync(METADATA_FILE, JSON.stringify(sampleMetadata, null, 2), 'utf8');
    console.log(`Created sample metadata file: ${METADATA_FILE}`);
    console.log('\n======================================================');
    console.log('BENCHMARK DIRECTORY INITIALIZED!');
    console.log('Please follow these steps to run the benchmark:');
    console.log(`1. Place TCG card images into: ${IMAGES_DIR}`);
    console.log(`2. Edit the metadata file to match your images: ${METADATA_FILE}`);
    console.log('3. Set your API Key: export GEMINI_API_KEY="your-key"');
    console.log('4. Run this script again.');
    console.log('======================================================\n');
    process.exit(0);
  }
}

// Call Google Gemini API directly
async function callGeminiDirect(base64Image, mimeType) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Image
            }
          },
          {
            text: systemPrompt
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema,
      temperature: 0.1
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API returned error status ${response.status}: ${text}`);
  }

  const result = await response.json();
  const textContent = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) {
    throw new Error('Gemini API did not return text content.');
  }

  return JSON.parse(textContent.trim());
}

// Call OpenRouter Gemini Vision API
async function callOpenRouter(base64Image, mimeType) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('Missing OPENROUTER_API_KEY environment variable.');
  }

  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const dataUri = `data:${mimeType};base64,${base64Image}`;

  const payload = {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt + '\nIMPORTANT: You must return ONLY valid JSON matching the requested structure.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Identify the card in this image and return the structured JSON.' },
          { type: 'image_url', image_url: { url: dataUri } }
        ]
      }
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://huntercard-benchmark.app',
      'X-Title': 'HunterCard Benchmark'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API returned error status ${response.status}: ${text}`);
  }

  const result = await response.json();
  const textContent = result.choices?.[0]?.message?.content;
  if (!textContent) {
    throw new Error('OpenRouter API did not return content.');
  }

  return JSON.parse(textContent.trim());
}

// Normalize strings for comparison
function cleanStr(str) {
  if (!str) return 'none';
  return str.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf-]/g, '').trim();
}

async function runBenchmark() {
  ensureDirectories();

  console.log(`Starting TCG Card Recognition Benchmark...`);
  console.log(`Provider: ${PROVIDER}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Metadata File: ${METADATA_FILE}`);

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
  } catch (e) {
    console.error(`Error reading metadata file: ${e.message}`);
    process.exit(1);
  }

  const testCases = metadata.images || [];
  if (testCases.length === 0) {
    console.log('No test cases found in metadata.json.');
    process.exit(0);
  }

  console.log(`Found ${testCases.length} test cases to run.\n`);

  const results = [];
  let stats = {
    total: 0,
    successfulScans: 0,
    failures: 0,
    cardNumCorrect: 0,
    charCorrect: 0,
    rarityCorrect: 0,
    hpCorrect: 0,
    titleCorrect: 0,
    totalLatency: 0
  };

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const imagePath = path.join(IMAGES_DIR, tc.filename);
    console.log(`[${i + 1}/${testCases.length}] Processing ${tc.filename}...`);

    if (!fs.existsSync(imagePath)) {
      console.warn(`  Warning: File ${tc.filename} not found in ${IMAGES_DIR}. Skipping.`);
      continue;
    }

    stats.total++;
    const startTime = Date.now();
    let status = 'SUCCESS';
    let output = null;
    let errorMsg = '';

    try {
      const ext = path.extname(tc.filename).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      const base64Image = fs.readFileSync(imagePath).toString('base64');

      if (PROVIDER === 'GEMINI') {
        output = await callGeminiDirect(base64Image, mimeType);
      } else {
        output = await callOpenRouter(base64Image, mimeType);
      }
    } catch (e) {
      status = 'FAILED';
      errorMsg = e.message;
      console.error(`  Error processing: ${e.message}`);
    }

    const latency = Date.now() - startTime;
    stats.totalLatency += latency;

    if (status === 'SUCCESS' && output) {
      stats.successfulScans++;

      const expected = tc.expected;
      const cardNumMatch = cleanStr(output.cardNumber) === cleanStr(expected.cardNumber);
      const charMatch = cleanStr(output.character) === cleanStr(expected.character);
      const rarityMatch = cleanStr(output.rarity) === cleanStr(expected.rarity);
      const hpMatch = cleanStr(output.hp) === cleanStr(expected.hp);
      const titleMatch = cleanStr(output.title) === cleanStr(expected.title);

      if (cardNumMatch) stats.cardNumCorrect++;
      if (charMatch) stats.charCorrect++;
      if (rarityMatch) stats.rarityCorrect++;
      if (hpMatch) stats.hpCorrect++;
      if (titleMatch) stats.titleCorrect++;

      results.push({
        filename: tc.filename,
        status: 'SUCCESS',
        latency,
        expected,
        got: output,
        matches: {
          cardNumber: cardNumMatch,
          character: charMatch,
          rarity: rarityMatch,
          hp: hpMatch,
          title: titleMatch
        }
      });

      console.log(`  Done in ${latency}ms. Match: [CardNum: ${cardNumMatch ? '✓' : '✗'}, Char: ${charMatch ? '✓' : '✗'}, Rarity: ${rarityMatch ? '✓' : '✗'}, HP: ${hpMatch ? '✓' : '✗'}]`);
    } else {
      stats.failures++;
      results.push({
        filename: tc.filename,
        status: 'FAILED',
        latency,
        error: errorMsg
      });
    }
  }

  // Generate Report
  const avgLatency = stats.total > 0 ? (stats.totalLatency / stats.total).toFixed(0) : 0;
  const cardNumAcc = stats.total > 0 ? ((stats.cardNumCorrect / stats.total) * 100).toFixed(1) : 0;
  const charAcc = stats.total > 0 ? ((stats.charCorrect / stats.total) * 100).toFixed(1) : 0;
  const rarityAcc = stats.total > 0 ? ((stats.rarityCorrect / stats.total) * 100).toFixed(1) : 0;
  const hpAcc = stats.total > 0 ? ((stats.hpCorrect / stats.total) * 100).toFixed(1) : 0;
  const titleAcc = stats.total > 0 ? ((stats.titleCorrect / stats.total) * 100).toFixed(1) : 0;

  console.log('\n======================================================');
  console.log('BENCHMARK COMPLETE!');
  console.log(`Total Run: ${stats.total}`);
  console.log(`Successful API Scans: ${stats.successfulScans}`);
  console.log(`API Failures/Errors: ${stats.failures}`);
  console.log(`Average Latency: ${avgLatency}ms`);
  console.log('------------------------------------------------------');
  console.log(`Card Number Accuracy: ${cardNumAcc}% (${stats.cardNumCorrect}/${stats.total})`);
  console.log(`Character Name Accuracy: ${charAcc}% (${stats.charCorrect}/${stats.total})`);
  console.log(`Rarity Accuracy: ${rarityAcc}% (${stats.rarityCorrect}/${stats.total})`);
  console.log(`HP Accuracy: ${hpAcc}% (${stats.hpCorrect}/${stats.total})`);
  console.log(`Title Accuracy: ${titleAcc}% (${stats.titleCorrect}/${stats.total})`);
  console.log('======================================================\n');

  // Format Markdown Report
  let markdown = `# TCG Card Recognition Accuracy Benchmark Report

**Benchmark Execution Date:** ${new Date().toISOString().split('T')[0]}
**Model Tested:** \`${MODEL}\`
**API Provider:** \`${PROVIDER}\`

## Summary Metrics

| Metric | Value |
| :--- | :--- |
| **Total Test Images** | ${stats.total} |
| **Successful Scans** | ${stats.successfulScans} |
| **API Failures** | ${stats.failures} |
| **Average Latency** | ${avgLatency} ms |
| **Card Number Accuracy** | **${cardNumAcc}%** (${stats.cardNumCorrect}/${stats.total}) |
| **Character Name Accuracy** | ${charAcc}% (${stats.charCorrect}/${stats.total}) |
| **Rarity Accuracy** | ${rarityAcc}% (${stats.rarityCorrect}/${stats.total}) |
| **HP Accuracy** | ${hpAcc}% (${stats.hpCorrect}/${stats.total}) |
| **Title Accuracy** | ${titleAcc}% (${stats.titleCorrect}/${stats.total}) |

## Detailed Results

| Image | Status | Latency | Expected Card # | Got Card # | Expected Char | Got Char | Card # Match | Char Match |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :---: | :---: |
`;

  results.forEach(r => {
    if (r.status === 'FAILED') {
      markdown += `| ${r.filename} | ❌ FAILED | ${r.latency}ms | - | - | - | - | - | - |\n`;
    } else {
      markdown += `| ${r.filename} | ✅ SUCCESS | ${r.latency}ms | \`${r.expected.cardNumber}\` | \`${r.got.cardNumber}\` | ${r.expected.character} | ${r.got.character} | ${r.matches.cardNumber ? '✓' : '✗'} | ${r.matches.character ? '✓' : '✗'} |\n`;
    }
  });

  fs.writeFileSync(REPORT_FILE, markdown, 'utf8');
  console.log(`Detailed report written to: ${REPORT_FILE}`);
}

runBenchmark();
