import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrapeYuyuPrices, isBrowserCrash } from './scrape-yuyu-prices.js';

function createPage({ name, gotoImpl, prices = {} }) {
  let evaluateCount = 0;
  return {
    __name: name,
    goto: gotoImpl,
    evaluate: async () => {
      evaluateCount += 1;
      if (evaluateCount % 2 === 1) {
        return {
          title: `${name} title`,
          bodyLen: 100,
          bodyTextLen: 50,
          cardProductCount: Object.keys(prices).length,
          otherSelectors: { itemList: 0, productList: 0, cardItem: 0, product: 0 },
        };
      }
      return prices;
    },
  };
}

async function testFinalCrashRelaunchesBeforeNextSeries() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyu-crash-test-'));
  const events = [];
  let launchCount = 0;

  const launchBrowserFn = async () => {
    const browserId = ++launchCount;
    events.push(`launch:${browserId}`);
    const browser = {
      close: async () => events.push(`close:${browserId}`),
    };
    const page = createPage({
      name: `page-${browserId}`,
      gotoImpl: async url => {
        events.push(`goto:${browserId}:${url}`);
        if (url.endsWith('/crashy')) {
          throw new Error('Protocol error (Runtime.callFunctionOn): Target closed');
        }
      },
      prices: browserId === 4 ? {
        'hBP01-001': { sellPrice: 100, name: 'success', timestamp: new Date().toISOString() },
      } : {},
    });
    return { browser, page };
  };

  const result = await scrapeYuyuPrices({
    launchBrowserFn,
    seriesPages: [
      { name: 'crashy', url: '/crashy' },
      { name: 'next', url: '/next' },
    ],
    sleepFn: async () => {},
    baseUrl: 'https://example.test',
    outputDir: tmpDir,
  });

  assert.equal(launchCount, 4, 'initial launch + two retry relaunches + final-crash relaunch');
  assert.deepEqual(
    events.filter(e => e.startsWith('goto:')),
    [
      'goto:1:https://example.test/crashy',
      'goto:2:https://example.test/crashy',
      'goto:3:https://example.test/crashy',
      'goto:4:https://example.test/next',
    ],
    'next series should run on the freshly relaunched browser after final crash',
  );
  assert.equal(result.totalCards, 1);
  assert.equal(result.seriesWithPrices, 1);
  assert.ok(fs.existsSync(path.join(tmpDir, 'yuyu-prices.json')));
}

async function testNormalErrorDoesNotRelaunch() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyu-normal-error-test-'));
  const events = [];
  let launchCount = 0;

  const launchBrowserFn = async () => {
    const browserId = ++launchCount;
    events.push(`launch:${browserId}`);
    return {
      browser: { close: async () => events.push(`close:${browserId}`) },
      page: createPage({
        name: `page-${browserId}`,
        gotoImpl: async url => {
          events.push(`goto:${browserId}:${url}`);
          if (url.endsWith('/normal-error')) {
            throw new Error('HTTP 500 from upstream');
          }
        },
        prices: {
          'hBP01-002': { sellPrice: 200, name: 'still alive', timestamp: new Date().toISOString() },
        },
      }),
    };
  };

  const result = await scrapeYuyuPrices({
    launchBrowserFn,
    seriesPages: [
      { name: 'normal-error', url: '/normal-error' },
      { name: 'next', url: '/next' },
    ],
    sleepFn: async () => {},
    baseUrl: 'https://example.test',
    outputDir: tmpDir,
  });

  assert.equal(launchCount, 1, 'normal per-series errors should not relaunch browser');
  assert.deepEqual(
    events.filter(e => e.startsWith('goto:')),
    [
      'goto:1:https://example.test/normal-error',
      'goto:1:https://example.test/next',
    ],
    'next series should keep the same page after a non-crash error',
  );
  assert.equal(result.totalCards, 1);
  assert.equal(result.seriesWithPrices, 1);
}

function testCrashClassifier() {
  assert.equal(isBrowserCrash(new Error('Protocol error (Target.activateTarget): Target closed')), true);
  assert.equal(isBrowserCrash(Object.assign(new Error('socket gone'), { name: 'TargetCloseError' })), true);
  assert.equal(isBrowserCrash(new Error('HTTP 500 from upstream')), false);
}

await testFinalCrashRelaunchesBeforeNextSeries();
await testNormalErrorDoesNotRelaunch();
testCrashClassifier();
console.log('✅ yuyu crash recovery tests passed');
