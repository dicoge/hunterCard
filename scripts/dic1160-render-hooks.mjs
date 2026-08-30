// DIC-1160: web-render hooks for scripts/test-app-icon-visuals.mjs.
//
// Extends the shared `web-render-hooks.mjs` behavior with a stub for
// `react-native-svg` so the test can render AppIcon through react-native-web
// without pulling in the platform-suffix (`.web.js`) resolver chain that
// `react-native-svg` relies on inside Metro.
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
const SAFE_AREA_STUB_URL = new URL('./fixtures/safe-area-context-stub.mjs', import.meta.url).href;
const SVG_STUB_URL = new URL('./fixtures/react-native-svg-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'react-native-svg') {
    return { url: SVG_STUB_URL, format: 'module', shortCircuit: true };
  }

  if (NATIVE_MODULE_STUBS.has(specifier) || (specifier.startsWith('expo-') && specifier !== 'expo-linking')) {
    return { url: STUB_URL, format: 'module', shortCircuit: true };
  }

  if (specifier === 'react-native-safe-area-context') {
    return { url: SAFE_AREA_STUB_URL, format: 'module', shortCircuit: true };
  }

  const aliased = PACKAGE_ALIASES.get(specifier);
  if (aliased) return next(aliased, context);

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
