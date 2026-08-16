/**
 * Regression guard for DIC-1043: a Web-standard handler must never be the default
 * export of a Node-runtime function.
 *
 * Background: Vercel's Node.js serverless runtime invokes `(req, res)` and ends the
 * invocation only when the handler WRITES to `res`. A Web-standard
 * `(Request) => Response` handler returns instead of writing, so the platform waits
 * for a response that never comes and the request hangs with zero bytes until
 * FUNCTION_INVOCATION_TIMEOUT. The failure looks like a platform outage — every
 * affected route hangs identically across deployments and code SHAs — which is why
 * DIC-1037 chased Fluid Compute and region pinning instead of the code.
 *
 * The control that proves it is code, not platform: `api/auth/*` declare the same
 * `runtime: 'nodejs'` on the same deployment and answer in ~0.3s, because they wrap
 * their Web handler in `toNodeHandler`.
 *
 * Invariant: every Node-runtime route under api/ default-exports `toNodeHandler(...)`.
 * Edge routes are exempt — the Edge runtime speaks Web Request/Response natively.
 * Dependency-free, matching scripts/test-vercel-api-routing.mjs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(__dirname, '..', 'api');

function routeFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // api/_lib holds shared modules, not routes.
    if (entry.isDirectory()) {
      if (entry.name !== '_lib') out.push(...routeFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const failures = [];
const checked = { edge: 0, node: 0 };

for (const file of routeFiles(apiDir).sort()) {
  const rel = path.relative(path.join(__dirname, '..'), file);
  const source = fs.readFileSync(file, 'utf-8');

  const runtime = source.match(/runtime:\s*['"](edge|nodejs)['"]/)?.[1];
  if (!runtime) {
    failures.push(`${rel} declares no runtime; it must export config.runtime 'nodejs' or 'edge'`);
    continue;
  }
  if (runtime === 'edge') {
    checked.edge++;
    continue;
  }

  checked.node++;
  if (!/export default\s+toNodeHandler\(/.test(source)) {
    failures.push(
      `${rel} runs on the Node runtime but does not default-export toNodeHandler(...); ` +
      'a Web-standard handler never writes `res`, so every request hangs until FUNCTION_INVOCATION_TIMEOUT',
    );
  }
}

if (failures.length > 0) {
  console.error('❌ Node-runtime handler adapter regression:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log(
  `✅ Node-runtime adapter guard passed (${checked.node} node routes wrapped, ${checked.edge} edge routes exempt).`,
);
