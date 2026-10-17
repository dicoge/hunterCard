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

const DEFAULT_REQUIRE: RequireImpl = () => {
  // The lint rule allowing `require` here is intentional: this is the
  // fail-safe fallback around a native module whose JS entry point can
  // itself throw at require time. Using a static `import` would defeat the
  // whole guard, because ESM binds run at load time — before ScanScreen
  // could ever wrap them in try/catch.
  //
  // The module name is intentionally a static string literal (not the
  // `moduleName` argument) because Metro's static analysis for Android/iOS
  // bundling rejects `require(<variable>)` — it can only resolve literal
  // require strings at bundle time. `nativeOcrRecognize` only ever loads
  // `expo-ocr-kit` in production; tests inject a `requireImpl` stub to
  // exercise every other module/error scenario, so this default never needs
  // to resolve any other module name.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-ocr-kit');
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

type OcrBox = { x: number; y: number; width: number; height: number };

/** One recognised unit of an automatic-capture probe, with its box in probe-image pixels. */
export interface ProbeOcrUnit {
  text: string;
  box: OcrBox | null;
}

/**
 * One text block of an automatic-capture probe. `lines` (each with its `elements`) are
 * present when the on-device reader exposes them — Android through the local
 * holohunter-ocr-geometry module (v42). Without them the block itself is the finest
 * unit: on iOS expo-ocr-kit returns one Vision observation per entry, which is a line.
 */
export interface ProbeOcrBlock extends ProbeOcrUnit {
  lines?: Array<ProbeOcrUnit & { elements: ProbeOcrUnit[] }>;
}

const toBox = (r: any): OcrBox | null =>
  r && [r.x, r.y, r.width, r.height].every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
    && r.width > 0 && r.height > 0
    ? { x: r.x, y: r.y, width: r.width, height: r.height }
    : null;

const toUnit = (u: any): ProbeOcrUnit | null =>
  typeof u?.text === 'string' ? { text: u.text, box: toBox(u.boundingBox) } : null;

/** Native geometry payload (blocks → lines → elements, boxes as `boundingBox`) → probe blocks. */
export function geometryBlocksFromNative(raw: unknown): ProbeOcrBlock[] {
  const blocks = Array.isArray(raw) ? raw : [];
  return blocks
    .map((b: any): ProbeOcrBlock | null => {
      const unit = toUnit(b);
      if (!unit) return null;
      const lines = Array.isArray(b.lines)
        ? b.lines.map((l: any) => {
          const line = toUnit(l);
          if (!line) return null;
          const elements = Array.isArray(l.elements) ? l.elements.map(toUnit).filter(Boolean) as ProbeOcrUnit[] : [];
          return { ...line, elements };
        }).filter(Boolean)
        : undefined;
      return lines ? { ...unit, lines } : unit;
    })
    .filter((b: ProbeOcrBlock | null): b is ProbeOcrBlock => !!b);
}

type GeometryModuleLike = { recognizeGeometry?: (uri: string) => Promise<unknown> };

const DEFAULT_GEOMETRY = (): GeometryModuleLike | null => {
  // The local Expo module modules/holohunter-ocr-geometry (Android only). Absent on iOS,
  // on web and in any build without it → null, and the probe falls back to expo-ocr-kit.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const core: any = require('expo-modules-core');
  return core?.requireOptionalNativeModule?.('HoloHunterOcrGeometry') ?? null;
};

/**
 * Probe-only reader for native automatic capture. The normal recognition path keeps
 * using nativeOcrRecognize (text only) — unchanged. Any failure → no blocks (the probe
 * says nothing).
 *
 * v42: on Android the trigger must measure the printed card NUMBER, not the ML Kit text
 * BLOCK it happens to be grouped into — the block's bounds change from frame to frame
 * whenever neighbouring text joins or leaves it, although the number has not moved
 * (PM reproduction BLOCK_GROUPING_REPRO: alternating grouping never stabilised). The
 * geometry module returns lines and elements; when it is not available, the
 * expo-ocr-kit blocks are used as before.
 */
export async function nativeOcrProbe(
  uri: string,
  deps: NativeOcrDeps & { geometryImpl?: () => GeometryModuleLike | null } = {},
): Promise<ProbeOcrBlock[]> {
  let geometry: GeometryModuleLike | null = null;
  try { geometry = (deps.geometryImpl ?? DEFAULT_GEOMETRY)(); } catch { geometry = null; }
  if (geometry && typeof geometry.recognizeGeometry === 'function') {
    try {
      const result: any = await geometry.recognizeGeometry(uri);
      return geometryBlocksFromNative(result?.blocks);
    } catch {
      // fall through to the block-only reader
    }
  }
  const requireImpl = deps.requireImpl ?? DEFAULT_REQUIRE;
  let mod: any;
  try { mod = requireImpl('expo-ocr-kit'); } catch { return []; }
  if (!mod || typeof mod.recognizeText !== 'function') return [];
  let result: any;
  try { result = await mod.recognizeText(uri); } catch { return []; }
  const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
  return blocks.map(toUnit).filter((b: ProbeOcrUnit | null): b is ProbeOcrUnit => !!b);
}
