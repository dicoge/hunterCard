#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');
const sourceFile = path.join(__dirname, 'scrape-fullahead-buy.js');
const tempFile = path.join(__dirname, '.tmp-scrape-fullahead-buy-test.mjs');
const outputFile = path.join(repoRoot, 'data/buy-prices/fullahead-prices.json');
const dbFile = path.join(repoRoot, 'data/database.json');

const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const firstCard = Object.values(db.cards || {}).find((card) => card.cardNumber);
if (!firstCard) throw new Error('No cardNumber found in data/database.json');

const originalOutput = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : null;
const sentinel = `${JSON.stringify({ __sentinel: { buyPrice: 123, timestamp: 'test' } }, null, 2)}\n`;

function withServer(mode, fn) {
  let apiCalls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><script>fetch('/fetchRecords.php?app=38&apiToken=test-token&lastRecId=-1')</script>`);
      return;
    }

    if (url.pathname === '/fetchRecords.php') {
      apiCalls += 1;
      if (mode === 'fail') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"planned failure"}');
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      const lastRecId = url.searchParams.get('lastRecId');
      if (lastRecId === '-1') {
        res.end(JSON.stringify({
          json: {
            records: [
              {
                ORGIN_CODE: { value: firstCard.cardNumber },
                PRODUCT_NAME: { value: `【TEST】${firstCard.cardNumber} テストカード` },
                PURCHASE_PRICE: { value: '777' },
                $id: { value: 1 },
              },
            ],
          },
        }));
      } else {
        res.end(JSON.stringify({ json: { records: [] } }));
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        const result = await fn(`http://127.0.0.1:${port}/`, () => apiCalls);
        server.close(() => resolve(result));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

function writeTempScript(fullaheadUrl) {
  const src = fs.readFileSync(sourceFile, 'utf8')
    .replace(
      "const FULLAHEAD_URL = 'https://fullahead-buy.com/?shopbrand=hocg';",
      `const FULLAHEAD_URL = '${fullaheadUrl}';`
    )
    // The local fixture page intentionally serves only enough HTML to trigger token capture;
    // avoid coupling this unit test to Puppeteer's network-idle heuristics.
    .replace("waitUntil: 'networkidle2'", "waitUntil: 'domcontentloaded'");
  fs.writeFileSync(tempFile, src, 'utf8');
}

function runTempScript() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tempFile], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

try {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  await withServer('fail', async (fullaheadUrl, getApiCalls) => {
    fs.writeFileSync(outputFile, sentinel, 'utf8');
    writeTempScript(fullaheadUrl);
    const result = await runTempScript();
    if (result.status === 0) {
      throw new Error(`Expected non-2xx run to exit non-zero, got 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    const after = fs.readFileSync(outputFile, 'utf8');
    if (after !== sentinel) throw new Error('Non-2xx run overwrote fullahead-prices.json');
    if (!/Fullahead page 0 failed: 503/.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`Expected 503 error in output\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    if (getApiCalls() === 0) throw new Error('Mock API was not called in failure scenario');
    console.log('ok - non-2xx exits non-zero and preserves existing output');
  });

  await withServer('success', async (fullaheadUrl, getApiCalls) => {
    writeTempScript(fullaheadUrl);
    const result = await runTempScript();
    if (result.status !== 0) {
      throw new Error(`Expected 2xx run to exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    const out = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    if (!out[firstCard.cardNumber] || out[firstCard.cardNumber].buyPrice !== 777) {
      throw new Error(`Expected output for ${firstCard.cardNumber} with buyPrice 777`);
    }
    if (getApiCalls() < 2) throw new Error('Expected pagination API calls in success scenario');
    console.log('ok - 2xx run exits zero and writes parsed output');
  });
} finally {
  try { fs.unlinkSync(tempFile); } catch {}
  if (originalOutput == null) {
    try { fs.unlinkSync(outputFile); } catch {}
  } else {
    fs.writeFileSync(outputFile, originalOutput, 'utf8');
  }
}
