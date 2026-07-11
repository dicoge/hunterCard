import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scriptPath = path.resolve('scripts/scrape-yt-stats.js');
const source = fs.readFileSync(scriptPath, 'utf8');

const mainStart = source.indexOf('async function main()');
assert.notEqual(mainStart, -1, 'main() exists');
const mainSource = source.slice(mainStart);
assert.equal(
  /canonicalChannelId\s*&&\s*canonicalChannelId\s*!==\s*channelId/.test(mainSource),
  false,
  'main() must not contain the old canonical mismatch branch; fallback belongs in fetchChannelStats()'
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-yt-stats-test-'));
const testablePath = path.join(tempDir, 'scrape-yt-stats-testable.mjs');
fs.writeFileSync(
  testablePath,
  source.replace(/main\(\)\.catch\(\(err\) => \{[\s\S]*?process\.exit\(1\);\n\}\);\s*$/m, 'export { fetchChannelStats };\n')
);

function aboutHtml({ channelId, subscribers = '1.23M subscribers', views = '456,789,012 views' }) {
  return `<html><script>var ytInitialData = {"metadata":{"aboutChannelViewModel":{"channelId":"${channelId}","subscriberCountText":"${subscribers}","viewCountText":"${views}"}}};</script></html>`;
}

function installFetchMock(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const route = routes.find(([needle]) => String(url).includes(needle));
    if (!route) throw new Error(`Unexpected fetch URL: ${url}`);
    const response = typeof route[1] === 'function' ? route[1](url) : route[1];
    return {
      status: response.status ?? 200,
      ok: response.ok ?? (response.status == null || (response.status >= 200 && response.status < 300)),
      text: async () => response.body ?? '',
    };
  };
  return calls;
}

const { fetchChannelStats } = await import(pathToFileURL(testablePath));

{
  const calls = installFetchMock([
    ['/@stale/about', { body: aboutHtml({ channelId: 'UC_WRONG', subscribers: '999K subscribers', views: '999 views' }) }],
    ['/channel/UC_EXPECTED/about', { body: aboutHtml({ channelId: 'UC_EXPECTED', subscribers: '2M subscribers', views: '123,456 views' }) }],
  ]);
  const stats = await fetchChannelStats('UC_EXPECTED', '@stale');
  assert.deepEqual(stats, {
    subscriberCount: 2000000,
    totalViewCount: 123456,
    canonicalChannelId: 'UC_EXPECTED',
  });
  assert.equal(calls.length, 2, 'canonical mismatch on handle should continue to channel fallback');
}

{
  const calls = installFetchMock([
    ['/@ok/about', { body: aboutHtml({ channelId: 'UC_MATCH', subscribers: '543 subscribers', views: '1,234 views' }) }],
    ['/channel/UC_MATCH/about', { body: aboutHtml({ channelId: 'UC_MATCH' }) }],
  ]);
  const stats = await fetchChannelStats('UC_MATCH', '@ok');
  assert.deepEqual(stats, {
    subscriberCount: 543,
    totalViewCount: 1234,
    canonicalChannelId: 'UC_MATCH',
  });
  assert.equal(calls.length, 1, 'matching handle should return immediately without changing normal flow');
}

{
  const calls = installFetchMock([
    ['/@wrong/about', { body: aboutHtml({ channelId: 'UC_WRONG_HANDLE' }) }],
    ['/channel/UC_EXPECTED/about', { body: aboutHtml({ channelId: 'UC_WRONG_CHANNEL' }) }],
  ]);
  const stats = await fetchChannelStats('UC_EXPECTED', '@wrong');
  assert.deepEqual(stats, { error: 'canonical_mismatch:UC_WRONG_CHANNEL' });
  assert.equal(calls.length, 2, 'all candidates should be exhausted before returning canonical mismatch');
}

console.log('scrape-yt-stats canonical fallback tests passed');
