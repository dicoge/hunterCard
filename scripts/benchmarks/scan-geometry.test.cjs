#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const src = path.resolve(__dirname, '../../src/utils/scanGeometry.ts');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-geometry-'));
const out = path.join(outDir, 'scanGeometry.cjs');
const code = fs.readFileSync(src, 'utf8');
fs.writeFileSync(out, ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText);
const { mapCoverRectToSource } = require(out);

function near(actual, expected, epsilon = 0.02) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ~= ${expected}`);
}

// Same aspect ratio: pure scale, no cover offset.
let r = mapCoverRectToSource(
  { width: 400, height: 300 },
  { width: 1600, height: 1200 },
  { x: 100, y: 75, width: 200, height: 150 },
);
near(r.x, 400); near(r.y, 300); near(r.width, 800); near(r.height, 600);

// Tall container: source is cropped horizontally by objectFit:cover.
r = mapCoverRectToSource(
  { width: 300, height: 600 },
  { width: 1920, height: 1080 },
  { x: 75, y: 200, width: 150, height: 100 },
);
near(r.x, 825); near(r.y, 360); near(r.width, 270); near(r.height, 180);

// Wide container: source is cropped vertically by objectFit:cover.
r = mapCoverRectToSource(
  { width: 800, height: 300 },
  { width: 1280, height: 720 },
  { x: 300, y: 100, width: 200, height: 80 },
);
near(r.x, 480); near(r.y, 280); near(r.width, 320); near(r.height, 128);

// Padding expands then clamps at source bounds.
r = mapCoverRectToSource(
  { width: 400, height: 300 },
  { width: 1600, height: 1200 },
  { x: 0, y: 0, width: 100, height: 100 },
  { padXRatio: 0.5, padYRatio: 0.25 },
);
near(r.x, 0); near(r.y, 0); near(r.width, 800); near(r.height, 600);

fs.rmSync(outDir, { recursive: true, force: true });
console.log('scan-geometry tests passed');
