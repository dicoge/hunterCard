// Run with: node --test scripts/lib/price-sanitizer.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePriceHistory, medianOf } from "./price-sanitizer.js";

const recs = (...prices) => prices.map((price, i) => ({ date: `d${i}`, price }));

test("blocker: [100,100] + spike 10000 is rejected, not capped", () => {
  // A spike with < 3 prior records must be dropped entirely (return null),
  // NOT written as the baseline-capped value (100). DIC-419 / DIC-414 blocker.
  assert.equal(sanitizePriceHistory(recs(100, 100), 10000), null);
});

test("single prior record + spike is rejected", () => {
  assert.equal(sanitizePriceHistory(recs(100), 10000), null);
});

test("normal price with < 3 records passes through unchanged", () => {
  assert.equal(sanitizePriceHistory(recs(100, 120), 130), 130);
});

test("price within spike factor (5x) is accepted", () => {
  assert.equal(sanitizePriceHistory(recs(100, 100), 500), 500);
});

test("just over spike factor is rejected", () => {
  assert.equal(sanitizePriceHistory(recs(100, 100), 501), null);
});

test("spike can't inflate its own baseline (>= 3 records)", () => {
  assert.equal(sanitizePriceHistory(recs(100, 100, 100), 10000), null);
});

test("no history: normal price passes", () => {
  assert.equal(sanitizePriceHistory([], 1200), 1200);
});

test("no history: price over absolute cap is capped to 50000", () => {
  assert.equal(sanitizePriceHistory([], 99999), 50000);
});

test("invalid candidate prices return null", () => {
  assert.equal(sanitizePriceHistory(recs(100), 0), null);
  assert.equal(sanitizePriceHistory(recs(100), -5), null);
  assert.equal(sanitizePriceHistory(recs(100), NaN), null);
});

test("existing records with no valid prices: candidate passes", () => {
  assert.equal(sanitizePriceHistory(recs(-1, 0), 300), 300);
});

test("medianOf handles even and odd lengths", () => {
  assert.equal(medianOf([100, 100]), 100);
  assert.equal(medianOf([1, 2, 3]), 2);
  assert.equal(medianOf([4, 1, 3, 2]), 2.5);
});
