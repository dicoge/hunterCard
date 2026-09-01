// Native OCR fallback path for the Scan screen (DIC-1286).
//
// The Closed Test Android APK crashed when opening the Scan screen; part of
// the fail-safe surface is that the OCR side of recognition must NEVER take
// down the render tree with an unhandled synchronous throw. That was a real
// risk because the previous code did `require('expo-ocr-kit')` at handler
// call-time — a synchronous `require` throw from a missing / broken native
// module would surface as an unhandled rejection deep inside a Promise
// chain, and could reach the ErrorBoundary as a render error later.
//
// Extracted here so the fail-safe contract can be tested behaviourally
// rather than by source-regex: the DIC-1289 CR reviewer flagged that
// asserting `try {` / `catch` shape in the source is not mutation-
// sensitive (a mutation that swaps `return ''` for `throw` in the catch
// still matches). Both blocker legs — the require throw AND the
// recognizeText runtime throw — are now tested by INVOKING this function
// with a mocked `requireImpl` and asserting the string it returns.
//
// Behavioural contract, verified by scripts/test-scan-screen-fail-safe.mjs:
//   • require throws           → resolves ''; caller never sees the error
//   • module missing            → resolves ''
//   • recognizeText not exported→ resolves ''
//   • recognizeText throws sync → resolves ''
//   • recognizeText rejects     → resolves ''
//   • recognizeText returns { text } → resolves the string verbatim
//   • recognizeText returns non-string → resolves ''

type RequireImpl = (moduleName: string) => unknown;

export interface NativeOcrDeps {
  /**
   * Injected module resolver. Defaults to the CommonJS `require` that
   * Metro / RN provides at runtime. Tests pass a stub to drive every
   * failure branch without needing to break the real expo-ocr-kit install.
   */
  requireImpl?: RequireImpl;
  /**
   * Logging seam so tests can assert without spamming stderr. Defaults to
   * console.warn to preserve the existing production behaviour.
   */
  logger?: (message: string, cause?: unknown) => void;
}

interface OcrModuleLike {
  recognizeText?: (uri: string) => Promise<{ text?: unknown } | null | undefined>;
}

const DEFAULT_REQUIRE: RequireImpl = (moduleName) => {
  // The lint rule allowing `require` here is intentional: this is the
  // fail-safe fallback around a native module whose JS entry point can
  // itself throw at require time. Using a static `import` would defeat the
  // whole guard, because ESM binds run at load time — before ScanScreen
  // could ever wrap them in try/catch.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(moduleName);
};

const DEFAULT_LOGGER = (message: string, cause?: unknown): void => {
  console.warn(`[nativeOcr] ${message}`, cause);
};

export async function nativeOcrRecognize(
  uri: string,
  deps: NativeOcrDeps = {},
): Promise<string> {
  const requireImpl = deps.requireImpl ?? DEFAULT_REQUIRE;
  const log = deps.logger ?? DEFAULT_LOGGER;

  let mod: OcrModuleLike | null;
  try {
    mod = requireImpl('expo-ocr-kit') as OcrModuleLike | null;
  } catch (loadErr) {
    log('expo-ocr-kit unavailable at require time; empty OCR fallback', loadErr);
    return '';
  }

  if (!mod || typeof mod.recognizeText !== 'function') {
    log('expo-ocr-kit missing recognizeText export; empty OCR fallback');
    return '';
  }

  let result: { text?: unknown } | null | undefined;
  try {
    result = await mod.recognizeText(uri);
  } catch (runErr) {
    log('expo-ocr-kit runtime failure; empty OCR fallback', runErr);
    return '';
  }

  return typeof result?.text === 'string' ? result.text : '';
}
