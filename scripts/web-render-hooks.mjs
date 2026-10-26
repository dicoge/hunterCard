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
  'expo-auth-session',
  'expo-crypto',
]);

const STUB_URL = new URL('./fixtures/native-module-stub.mjs', import.meta.url).href;

// react-native-safe-area-context pulls the Flow-typed `react-native` package in
// through CJS `require`, which the alias below cannot reach. It only supplies
// device inset padding — zero on web — so it resolves to a passthrough.
const SAFE_AREA_STUB_URL = new URL('./fixtures/safe-area-context-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (NATIVE_MODULE_STUBS.has(specifier) || (specifier.startsWith('expo-') && specifier !== 'expo-linking')) {
    return { url: STUB_URL, format: 'module', shortCircuit: true };
  }

  if (specifier === 'react-native-safe-area-context') {
    return { url: SAFE_AREA_STUB_URL, format: 'module', shortCircuit: true };
  }

  const aliased = PACKAGE_ALIASES.get(specifier);
  if (aliased) return next(aliased, context);

  const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('.');
  if (extname(specifier) === '' && context.parentURL) {
    for (const suffix of ['.tsx', '.ts', '.js', '/index.tsx', '/index.ts', '/index.js']) {
      try {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      } catch {}
    }
  }

  return next(specifier, context);
}

// Image asset stub — Metro/Webpack resolves `require('./foo.jpg')` to a
// per-platform representation (object on native, hashed URL on web). Under
// Node we synthesize a source string whose value contains the ORIGINAL
// filename so a regression can prove that a specific catalog card artwork
// reached the shipped surface (DIC-1381 W9 CR — the Landing hero cards).
// react-native-web's <Image source="…"> renders <img src="…"> unchanged, so
// the DOM `src` attribute carries the filename anchor test-landing-pen-
// render.mjs derives from the Pen `image` fill URL.
function imageStubSource(url) {
  const p = fileURLToPath(url);
  const name = p.split(/[\/\\]/).pop() || 'asset';
  return `export default ${JSON.stringify('/__test-asset__/' + name)};`;
}
const IMAGE_ASSET_RE = /\.(jpg|jpeg|png|gif|webp|svg)$/i;

export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'json', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }

  if (IMAGE_ASSET_RE.test(url)) {
    return { format: 'module', source: imageStubSource(url), shortCircuit: true };
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
