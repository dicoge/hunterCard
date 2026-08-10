// Node --import hook for regressions that exercise app modules which use
// Metro-style extensionless relative imports (e.g. the deck store imports
// '../stores/storage' and '../utils/deckRules'). Metro adds the extension at
// bundle time; Node's ESM loader does not, so this hook resolves an
// extensionless relative specifier to its `.ts` file when one exists. It also
// loads `.json` imports as JSON modules (same as register-json.mjs) so the
// deck-rules single-source-of-truth import resolves under `--experimental-strip-types`.
//
// Registered via package.json test scripts, not app code. Platform-specific
// files (storage.web.ts / storage.native.ts) are never selected here — Node
// falls back to the plain `.ts`, which is exactly the intended test target.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { readFileSync, existsSync } from 'node:fs';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      import { extname } from 'node:path';

      export async function resolve(specifier, context, next) {
        const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
        if (isRelative && extname(specifier) === '' && context.parentURL) {
          const candidateUrl = new URL(specifier + '.ts', context.parentURL);
          if (existsSync(fileURLToPath(candidateUrl))) {
            return next(candidateUrl.href, context);
          }
        }
        return next(specifier, context);
      }

      export async function load(url, context, next) {
        if (url.endsWith('.json')) {
          return {
            format: 'json',
            source: readFileSync(fileURLToPath(url), 'utf8'),
            shortCircuit: true,
          };
        }
        return next(url, context);
      }
    `),
  import.meta.url,
);
