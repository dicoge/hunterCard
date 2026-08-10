// Lets the deck-rules regressions import `data/deck-rules.json` with a plain
// default import under `node --experimental-strip-types`. Node's native ESM
// loader demands an `import ... with { type: 'json' }` attribute, but Metro's
// hermes-parser rejects that attribute — so runtime code (src/utils/deckRules.ts)
// uses the plain, attribute-free import that Metro bundles natively, and this
// `--import` hook teaches Node to resolve those same plain `.json` imports as
// JSON modules. Registered via package.json test scripts, not app code.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { readFileSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
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
