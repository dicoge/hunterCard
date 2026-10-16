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
 * After every round (automatic or manual) it disarms. It re-arms only when the card
 * that was scanned is no longer in the frame (after a manual round, when no card
 * number is readable at all) — so a card left in front of the camera is never
 * recognised again, and an Add is never offered twice for it. A new card replacing
 * the old one directly re-arms immediately. After `maxIdleProbes` probes without a
 * stable card it pauses (battery / storage); the shutter, or re-enabling the
 * automatic mode, resumes it. It never retries on its own after a failure: the screen
 * stops probing while any result or error is on screen.
 */
export interface AutoCaptureOptions {
  stableHits?: number;
  maxIdleProbes?: number;
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
  let armed = true;
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
        if (!gone) {
          // The scanned card is still there: keep waiting, but not forever.
          idleProbes += 1;
          if (idleProbes >= maxIdleProbes) paused = true;
          return 'none';
        }
        armed = true;
        held = null;
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
      clearCandidate();
      idleProbes = 0;
      return 'trigger';
    },
    roundStarted(token) {
      armed = false;
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
