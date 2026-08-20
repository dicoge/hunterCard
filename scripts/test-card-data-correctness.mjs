import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PriceTrend } from '../src/components/PriceTrend.tsx';
import { hasDisplayableSubscriberStats, isValidatedTrendPrediction } from '../src/utils/cardNormalization.ts';
import { computeValidatedPriceTrend } from '../src/utils/priceTrend.ts';
import { computeYtGrowth } from './build-database.js';

const identity = { cardNumber: 'hBP01-001', printing: 'BASE', currency: 'JPY' };

const rising = computeValidatedPriceTrend({
  priceHistory: {
    '2026-08-01T00:00:00Z': 100,
    '2026-08-07T00:00:00Z': 100,
    '2026-08-08T00:00:00Z': 200,
    '2026-08-14T00:00:00Z': 200,
  },
  meta: identity,
  ...identity,
});
assert.ok(rising, 'exact card/printing/currency history with distinct timestamps must produce a trend');
assert.equal(rising.direction, 'up', '100% increase must point up');
assert.equal(rising.percentage, 100, 'trend percentage must use the two exact seven-day averages');
assert.equal(rising.priorAverage, 100);
assert.equal(rising.recentAverage, 200);

const falling = computeValidatedPriceTrend({
  priceHistory: {
    '2026-08-01T00:00:00Z': 200,
    '2026-08-07T00:00:00Z': 200,
    '2026-08-08T00:00:00Z': 100,
    '2026-08-14T00:00:00Z': 100,
  },
  meta: identity,
  ...identity,
});
assert.ok(falling);
assert.equal(falling.direction, 'down', '50% decrease must point down');
assert.equal(falling.percentage, -50);

assert.equal(computeValidatedPriceTrend({
  priceHistory: { '2026-08-01': 100, '2026-08-08': 200, '2026-08-14': 300 },
  meta: { ...identity, printing: 'PARALLEL' },
  ...identity,
}), null, 'cross-printing history must fail closed');
assert.equal(computeValidatedPriceTrend({
  priceHistory: { '2026-08-01': 100, '2026-08-14': 200 },
  meta: identity,
  ...identity,
}), null, 'fewer than three distinct timestamps must fail closed');

assert.equal(renderToStaticMarkup(React.createElement(PriceTrend, { trend: null })), '', 'invalid trend must render no container or placeholder');
const renderedTrend = renderToStaticMarkup(React.createElement(PriceTrend, { trend: rising }));
assert.match(renderedTrend, /↑/);
assert.match(renderedTrend, /\+100\.0%/);
assert.doesNotMatch(renderedTrend, /資料不足|歷史資料累積中|—/);

const cardDetailSource = fs.readFileSync(new URL('../src/screens/CardDetailScreen.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(cardDetailSource, /暫無歷史均價|歷史資料累積中|<PriceTrend\s+priceHistory=/, 'CardDetail must not retain a placeholder trend path');

const predictionCard = { cardNumber: 'hBP01-001', printing: 'BASE', currency: 'JPY' };
const prediction = {
  trend: 'up', score: 0.5, confidence: 0.8, dataPoints: 3,
  timestamps: ['2026-08-01', '2026-08-08', '2026-08-15'],
  cardNumber: 'hBP01-001', printing: 'BASE', currency: 'JPY',
};
assert.equal(isValidatedTrendPrediction(prediction, predictionCard), true, 'prediction direction must agree with its numeric score');
assert.equal(isValidatedTrendPrediction({ ...prediction, score: -0.5 }, predictionCard), false, 'contradictory up/negative prediction must fail closed');
assert.equal(isValidatedTrendPrediction({ ...prediction, trend: 'stable', score: 0.5 }, predictionCard), false, 'stable prediction outside the stable threshold must fail closed');

const oldSubscriberFetchedAt = '2026-08-01T01:00:00Z';
const freshViewFetchedAt = '2026-08-20T01:00:00Z';
const stats = computeYtGrowth([
  {
    date: '2026-08-01', subscriberCount: 1000, totalViewCount: 5000,
    channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', source: 'youtube_about_ssr',
    parser: 'ytInitialData.aboutChannelViewModel/v1', fetchedAt: oldSubscriberFetchedAt,
  },
  {
    date: '2026-08-20', subscriberCount: null, totalViewCount: 9000,
    channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', source: 'youtube_about_ssr',
    parser: 'ytInitialData.aboutChannelViewModel/v1', fetchedAt: freshViewFetchedAt,
  },
]);
assert.equal(stats.subscriberCount, 1000, 'last-known-good subscriber value must survive a view-only snapshot');
assert.equal(stats.fetchedAt, oldSubscriberFetchedAt, 'subscriber provenance must come from the snapshot that supplied subscriberCount');
assert.equal(stats.viewFetchedAt, freshViewFetchedAt, 'view provenance must remain independently fresh');
assert.equal(hasDisplayableSubscriberStats(stats, Date.parse('2026-08-20T02:00:00Z')), false, 'an old subscriber value must not borrow a fresh view timestamp');

const provenZero = {
  subscriberCount: 0,
  channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb',
  source: 'youtube_about_ssr',
  parser: 'ytInitialData.aboutChannelViewModel/v1',
  fetchedAt: '2026-08-20T01:00:00Z',
};
assert.equal(hasDisplayableSubscriberStats(provenZero, Date.parse('2026-08-20T02:00:00Z')), true, 'authoritative fresh zero may display');

console.log('DIC-1084 mutation-sensitive card-data correctness checks passed');
