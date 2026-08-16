// Node --import hook that swaps `@vercel/kv` for the in-memory fixture, so the
// real /api/push/* handlers can be imported and run in a Node regression without
// KV credentials or network access. Also carries the extensionless-relative-.ts
// and JSON resolution from register-ts.mjs, since the handlers reach into src/.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const kvMockUrl = pathToFileURL(new URL('./fixtures/kv-mock.mjs', import.meta.url).pathname).href;

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { readFileSync, existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      import { extname } from 'node:path';

      const KV_MOCK_URL = ${JSON.stringify(kvMockUrl)};

      export async function resolve(specifier, context, next) {
        if (specifier === '@vercel/kv') return { url: KV_MOCK_URL, shortCircuit: true };
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
