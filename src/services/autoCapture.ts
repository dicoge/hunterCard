/**
 * Native automatic capture (v41, user request 2026-10-17: "automatic scan instead of
 * the shutter"). Dependency-free decision logic; ScanScreen supplies the probes.
 *
 * What a probe is: a small, silent, local photo of the camera view, cropped to the
 * scan frame and read by the ON-DEVICE text recognizer (expo-ocr-kit). Nothing of a
 * probe is uploaded — no AI call, no quota. A probe only says which strictly valid
 * card numbers (src/utils/cardNumberToken, whole-token) are readable inside the frame.
 *
 * When does it trigger the normal scan (one recognition request)?
 *   • exactly ONE valid card number is readable in the probe, and
 *   • the reader's bounding box of that number lies INSIDE the scan frame (not in the
 *     crop's padding margin), and
 *   • on `stableHits` consecutive probes it is the same number whose box stayed put
 *     (centre moved ≤ `maxMove` of the frame per axis, size changed ≤ `maxSizeChange`)
 *     — the number is held still in the frame, and
 *   • the machine is armed.
 * A reading without a box (the reader returned none) never counts. What is measured is
 * the printed card NUMBER's position — not the card's full outline: a card whose
 * number is inside the frame but whose edges are cut off still triggers.
 *
 * After every round (automatic or manual) it disarms. It re-arms only after
 * `absentToRearm` (3) CONSECUTIVE probes without the card that was scanned (after a
 * manual round: without any readable number) — a single missed read or a single
 * misread token while the same card stays does not re-arm. What this can and cannot
 * know: it reads TEXT, so "the card left the frame" means "its number was not
 * readable for ~4 s"; covering the number for that long with the same card in place
 * would re-arm it (a second recognition request, still no charge without Add). It is
 * not a pixel-motion or card-outline detector. After `maxIdleProbes` probes without a
 * stable card it pauses (battery / storage); the shutter, or re-enabling the
 * automatic mode, resumes it. It never retries on its own after a failure: the screen
 * stops probing while any result or error is on screen.
 */
export interface AutoCaptureOptions {
  stableHits?: number;
  maxIdleProbes?: number;
  /** Consecutive probes without the scanned card before re-arming (OCR noise guard). */
  absentToRearm?: number;
  /** Where the scan frame lies inside a probe crop (normalised 0..1); default from CROP_PAD. */
  frameRegion?: NormBox;
  /** Max centre movement between consecutive hits, as a fraction of the crop per axis. */
  maxMove?: number;
  /** Max relative change of the box width / height between consecutive hits. */
  maxSizeChange?: number;
}

/** A box normalised to the probe crop: 0..1 on each axis. */
export interface NormBox { x: number; y: number; width: number; height: number }
/** One card number the on-device reader found in a probe, with where it was. */
export interface ProbeObservation { token: string; box?: NormBox | null }

/**
 * The probe crop is the frame plus CROP_PAD (6 % / 4 % of the frame on each side,
 * src/utils/scanFrame); the frame is the inner part of it. Near the photo edge the pad
 * can be clipped — then this region is slightly smaller than the real frame (stricter).
 */
export const DEFAULT_FRAME_REGION: NormBox = (() => {
  const px = 0.06 / (1 + 2 * 0.06);
  const py = 0.04 / (1 + 2 * 0.04);
  return { x: px, y: py, width: 1 - 2 * px, height: 1 - 2 * py };
})();

const inside = (b: NormBox, r: NormBox) =>
  b.width > 0 && b.height > 0
  && b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height;
const steady = (a: NormBox, b: NormBox, maxMove: number, maxSize: number) =>
  Math.abs((a.x + a.width / 2) - (b.x + b.width / 2)) <= maxMove
  && Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) <= maxMove
  && Math.abs(b.width - a.width) <= maxSize * a.width
  && Math.abs(b.height - a.height) <= maxSize * a.height;

export type AutoCaptureDecision = 'none' | 'trigger';

/** '*' = a manual round: wait until no card number is readable before re-arming. */
type Held = string | '*' | null;

export interface AutoCaptureMachine {
  /** One probe's readable card numbers (whole-token validated) with their boxes. A bare
   *  string has no box and can never trigger. */
  onProbe(observations: Array<ProbeObservation | string>): AutoCaptureDecision;
  /** A round began (auto trigger or the shutter). */
  roundStarted(token?: string | null): void;
  /** Resume after an idle pause (user action). */
  resume(): void;
  state(): { armed: boolean; held: Held; candidate: string | null; hits: number; idleProbes: number; paused: boolean };
}

export function createAutoCaptureMachine(options: AutoCaptureOptions = {}): AutoCaptureMachine {
  const stableHits = Math.max(2, options.stableHits ?? 2);
  const maxIdleProbes = Math.max(1, options.maxIdleProbes ?? 45);
  const absentToRearm = Math.max(2, options.absentToRearm ?? 3);
  const frameRegion = options.frameRegion ?? DEFAULT_FRAME_REGION;
  const maxMove = options.maxMove ?? 0.03;
  const maxSizeChange = options.maxSizeChange ?? 0.2;
  let lastBox: NormBox | null = null;
  let armed = true;
  let absent = 0;
  let held: Held = null;
  let candidate: string | null = null;
  let hits = 0;
  let idleProbes = 0;
  let paused = false;

  const clearCandidate = () => { candidate = null; hits = 0; lastBox = null; };

  return {
    onProbe(raw) {
      if (paused) return 'none';
      const observations: ProbeObservation[] = raw.map((o) => (typeof o === 'string' ? { token: o } : o));
      const unique = [...new Set(observations.map((o) => o.token))];
      if (!armed) {
        // Re-arm only once the scanned card has left the frame.
        const gone = held === '*' ? unique.length === 0 : !unique.includes(held as string);
        // One missed read (glare, a finger) or one misread token is OCR noise, not the
        // card leaving: only `absentToRearm` consecutive probes without it re-arm.
        absent = gone ? absent + 1 : 0;
        if (absent < absentToRearm) {
          idleProbes += 1;
          if (idleProbes >= maxIdleProbes) paused = true;
          return 'none';
        }
        armed = true;
        held = null;
        absent = 0;
        clearCandidate();
        idleProbes = 0;
        // fall through: this probe may already show the next card
      }
      if (unique.length !== 1) {
        clearCandidate();
        idleProbes += 1;
        if (idleProbes >= maxIdleProbes) paused = true;
        return 'none';
      }
      const token = unique[0];
      const boxes = observations.filter((o) => o.token === token).map((o) => o.box);
      const box = boxes.length === 1 ? boxes[0] : null;   // the same number twice = ambiguous
      if (!box || !inside(box, frameRegion)) {
        // Not provably inside the frame (no box, or the number sits in the margin).
        clearCandidate();
        idleProbes += 1;
        if (idleProbes >= maxIdleProbes) paused = true;
        return 'none';
      }
      if (token === candidate && lastBox && steady(lastBox, box, maxMove, maxSizeChange)) hits += 1;
      else { candidate = token; hits = 1; }
      lastBox = box;
      if (hits < stableHits) return 'none';
      armed = false;
      held = token;
      absent = 0;
      clearCandidate();
      idleProbes = 0;
      return 'trigger';
    },
    roundStarted(token) {
      armed = false;
      absent = 0;
      held = token ?? '*';
      clearCandidate();
      idleProbes = 0;
      paused = false;
    },
    resume() {
      paused = false;
      idleProbes = 0;
    },
    state: () => ({ armed, held, candidate, hits, idleProbes, paused }),
  };
}

/** Minimum time between two probes; a probe also never starts while one is running. */
export const AUTO_CAPTURE_PROBE_INTERVAL_MS = 1300;

type PixelBox = { x: number; y: number; width: number; height: number };
type ProbeUnit = { text: string; box: PixelBox | null };
/** The probe reader's output (src/services/nativeOcr ProbeOcrBlock), structurally. */
export interface ProbeTextBlock extends ProbeUnit {
  lines?: Array<ProbeUnit & { elements?: ProbeUnit[] }>;
}

/**
 * v42 (Android): WHERE a card number is = the box of the number itself — the ML Kit
 * element (word) that reads as the number, else the line that contains it. The text
 * BLOCK box is used only when the reader gives no lines (iOS, whose entries are Vision
 * line observations already) or when the number is split across lines. A block groups
 * whatever text ML Kit puts together on that frame, so its bounds move although the
 * printed number did not; measuring it made a card held still look like it moved.
 * Boxes are normalised to the probe crop (0..1). The trigger rules are unchanged.
 */
export function observationsFromProbeText(
  blocks: readonly ProbeTextBlock[],
  tokenize: (text: string) => string[],
  cropWidth: number,
  cropHeight: number,
  /** Where the crop starts in the reader's image (preview frames: the frame crop inside the whole camera frame). */
  originX = 0,
  originY = 0,
): ProbeObservation[] {
  const norm = (b: PixelBox | null | undefined): NormBox | null =>
    b && cropWidth > 0 && cropHeight > 0
      ? { x: (b.x - originX) / cropWidth, y: (b.y - originY) / cropHeight, width: b.width / cropWidth, height: b.height / cropHeight }
      : null;
  const out: ProbeObservation[] = [];
  for (const block of blocks) {
    const seen = new Set<string>();
    for (const line of block.lines ?? []) {
      for (const token of tokenize(line.text)) {
        seen.add(token);
        const element = (line.elements ?? []).find((e) => tokenize(e.text).includes(token));
        out.push({ token, box: norm(element?.box ?? line.box) });
      }
    }
    for (const token of tokenize(block.text)) {
      if (!seen.has(token)) out.push({ token, box: norm(block.box) });
    }
  }
  return out;
}
