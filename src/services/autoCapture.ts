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
 *   • exactly ONE valid card number is inside the frame, and
 *   • the SAME number was read on `stableHits` consecutive probes (the card is held
 *     still and legible), and
 *   • the machine is armed.
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
}

export type AutoCaptureDecision = 'none' | 'trigger';

/** '*' = a manual round: wait until no card number is readable before re-arming. */
type Held = string | '*' | null;

export interface AutoCaptureMachine {
  /** One probe's readable card numbers (already whole-token validated). */
  onProbe(tokens: string[]): AutoCaptureDecision;
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
  let armed = true;
  let absent = 0;
  let held: Held = null;
  let candidate: string | null = null;
  let hits = 0;
  let idleProbes = 0;
  let paused = false;

  const clearCandidate = () => { candidate = null; hits = 0; };

  return {
    onProbe(tokens) {
      if (paused) return 'none';
      const unique = [...new Set(tokens)];
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
      if (token === candidate) hits += 1;
      else { candidate = token; hits = 1; }
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
