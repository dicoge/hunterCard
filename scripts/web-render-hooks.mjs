// Module hooks that let a Node regression import and RENDER a real screen the
// same way the shipped web build does. `register-ts.mjs` is enough for plain
// `.ts` logic modules, but a screen is `.tsx` and pulls in `react-native`:
//
//   • Node's `--experimental-strip-types` erases types, it does NOT compile JSX,
//     so `.tsx` has to be transpiled here (TypeScript is already a devDependency);
//   • `react-native` is the Flow-typed native package Node cannot parse. The web
//     build never uses it either — Metro/Expo alias it to `react-native-web`, so
//     this hook applies the same alias and the test exercises the real web
//     component tree (`testID` → `data-testid`) rather than a hand-written stub;
//   • `expo-notifications` / `expo-constants` reach for the native runtime at
//     import time. They arrive transitively through the price-alert push service
//     and are inert for rendering, so they resolve to a minimal stub. Nothing
//     under test is stubbed: screens, stores and utils are the real modules.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import ts from 'typescript';

const PACKAGE_ALIASES = new Map([
  ['react-native', 'react-native-web'],
]);

const NATIVE_MODULE_STUBS = new Set([
  'expo-notifications',
  'expo-constants',
  'expo-device',
]);

const STUB_URL = new URL('./fixtures/native-module-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (NATIVE_MODULE_STUBS.has(specifier)) {
    return { url: STUB_URL, format: 'module', shortCircuit: true };
  }

  const aliased = PACKAGE_ALIASES.get(specifier);
  if (aliased) return next(aliased, context);

  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (isRelative && extname(specifier) === '' && context.parentURL) {
    for (const suffix of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
      const candidate = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
  }

  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'json', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }

  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      fileName: fileURLToPath(url),
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        isolatedModules: true,
      },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }

  return next(url, context);
}
