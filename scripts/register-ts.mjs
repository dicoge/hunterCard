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
          const indexCandidateUrl = new URL(specifier + '/index.ts', context.parentURL);
          if (existsSync(fileURLToPath(indexCandidateUrl))) {
            return next(indexCandidateUrl.href, context);
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
