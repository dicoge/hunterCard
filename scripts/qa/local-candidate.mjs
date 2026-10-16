#!/usr/bin/env node
/**
 * TEST-ONLY localhost harness for interactive QA of a candidate build (v41).
 * Never bundled into the app, never deployed, never touches real data or accounts.
 *
 * One origin (http://127.0.0.1:${QA_PORT:-8790}) so the web app's same-origin /api calls
 * stay local:
 *   /api/auth/*          → the REAL api/auth/[action] handler (sync, me, …) over an
 *                          in-memory KV emulation (scripts/fixtures/account-sync-server.cjs)
 *   /api/recognize-card  → the REAL recognize-card handler; the vision provider is
 *                          MOCKED (canned replies, switchable at /__qa/provider)
 *   /__qa/login?subject=qa-a  signs a synthetic identity in through the real session
 *                          signer: seeds the app's persisted auth, the app then validates
 *                          it against /api/auth/me like any launch (no app-side backdoor)
 *   /__qa/logout          clears that seed
 *   /__qa/provider?mode=kanata|iroha-corrected|no-number|down|busy
 *   /__qa/offline?on=1|0  account sync behaves like a phone without network (the
 *                          connection is dropped, no HTTP answer); pages keep loading
 *   everything else      → proxied to the Expo web dev server ($EXPO_DEV_URL,
 *                          default http://127.0.0.1:8081), started separately with
 *                          `EXPO_PUBLIC_STORE_MVP=1 npx expo start --web --port 8081`
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --import ./scripts/register-ts.mjs scripts/qa/local-candidate.mjs
 * Every secret here is a fixed test value; nothing is read from the environment
 * except the two ports.
 */
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.QA_PORT || 8790);
const EXPO = process.env.EXPO_DEV_URL || 'http://127.0.0.1:8081';

const { start } = require('../fixtures/account-sync-server.cjs');
const authServer = await start();

const DB = JSON.parse(fs.readFileSync(new URL('../../public/data/database.json', import.meta.url), 'utf8'));
const REPLIES = {
  kanata: 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた\nSET: hBP01\nLANGUAGE: JA\nRARITY: U\nTITLE: NONE',
  'iroha-corrected': 'CHARACTER: 風真いろは\nCARD_NUMBER: hBP05-081\nSET: hBP05\nLANGUAGE: JA\nRARITY: SR\nTITLE: NONE',
  'no-number': 'CARD_NUMBER: NONE\nCHARACTER: NONE\nTITLE: NONE',
};
let providerMode = 'kanata';
let syncOffline = false;
const realFetch = globalThis.fetch;
process.env.GEMINI_API_KEY = 'qa-harness-not-a-key';
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.endsWith('/data/database.json')) return Response.json(DB);
  if (href.includes('generativelanguage.googleapis.com')) {
    if (providerMode === 'down') return new Response('down', { status: 500 });
    if (providerMode === 'busy') return new Response('busy', { status: 429 });
    return Response.json({ candidates: [{ content: { parts: [{ text: REPLIES[providerMode] ?? REPLIES.kanata }] } }] });
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(href)) return realFetch(url, init);
  throw new Error(`QA harness blocks outbound request: ${href}`);
};
const recognize = (await import('../../api/recognize-card.ts')).default;

const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const send = (res, status, text, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(text); };

async function proxy(req, res, target) {
  const raw = await body(req);
  const r = await realFetch(target + req.url, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
  });
  res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'transfer-encoding', 'content-length'].includes(k))));
  res.end(Buffer.from(await r.arrayBuffer()));
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/__qa/login') {
      const subject = (url.searchParams.get('subject') || 'qa-a').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
      const { user, session } = await authServer.createSession(`qa-${subject}`);
      const seed = JSON.stringify({ state: { user, session, isGuest: false, role: user.role ?? 'free_user' }, version: 1 });
      return send(res, 200, `<!doctype html><meta charset="utf-8"><p>QA sign-in: ${subject} (${user.internalId})</p><script>localStorage.setItem('holohunter-auth', ${JSON.stringify(seed)});location.replace('/');</script>`, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/__qa/logout') {
      return send(res, 200, `<!doctype html><script>localStorage.removeItem('holohunter-auth');location.replace('/');</script>`, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/__qa/provider') {
      const mode = url.searchParams.get('mode');
      if (mode && (REPLIES[mode] || mode === 'down' || mode === 'busy')) providerMode = mode;
      return send(res, 200, JSON.stringify({ providerMode }));
    }
    if (url.pathname === '/__qa/offline') {
      syncOffline = url.searchParams.get('on') === '1';
      return send(res, 200, JSON.stringify({ syncOffline }));
    }
    if (url.pathname === '/api/auth/sync' && syncOffline) { req.socket.destroy(); return; }
    if (url.pathname.startsWith('/api/auth/')) return await proxy(req, res, `http://127.0.0.1:${authServer.port}`);
    if (url.pathname === '/api/recognize-card') {
      const raw = await body(req);
      const r = await recognize(new Request(`http://127.0.0.1:${PORT}/api/recognize-card`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? raw : undefined }));
      return send(res, r.status, await r.text());
    }
    return await proxy(req, res, EXPO);
  } catch (e) {
    return send(res, 502, JSON.stringify({ error: 'qa_harness', detail: String(e?.message || e) }));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`QA harness on http://127.0.0.1:${PORT} (auth/sync: real handler, KV emulated; provider mocked: ${providerMode}; app proxied from ${EXPO})`);
});
