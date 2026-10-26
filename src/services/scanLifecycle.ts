/**
 * Scan job lifecycle for ScanScreen (CR remediation 2026-10-14, P2_1).
 *
 * ScanScreen lives in a drawer: closing it or opening another drawer item BLURS the
 * screen but does not unmount it. Aborting only on unmount let a delayed recognition
 * resolve off-screen and commit a card — charging the shared 50/month quota for a scan
 * the user had walked away from.
 *
 * So every scan is a numbered job. Leaving the screen (navigation `blur`, the close
 * button, unmount) cancels the current job: its AbortSignal fires and its generation
 * is retired. A job only counts while the screen is focused AND it is still the current
 * generation — re-focusing never revives a retired job, and starting a new scan retires
 * any leftover one. Commits are additionally refused whenever the screen is not focused.
 *
 * Dependency-free so a Node regression drives this exact object; ScanScreen wires it to
 * React Navigation via bindScanLifecycleToNavigation.
 */

export interface ScanJob {
  readonly generation: number;
  readonly signal: AbortSignal;
  /** True while this job may still touch UI / commit: focused, current, not aborted. */
  isCurrent(): boolean;
}

export interface ScanLifecycle {
  /** Starts a job, retiring (aborting) any previous one. Null when the screen is not focused. */
  begin(): ScanJob | null;
  /** Releases `job` if it is still current. Never touches a newer job. */
  end(job: ScanJob): void;
  /** Aborts and retires the current job. Returns true if one was running. */
  cancel(): boolean;
  /** Focus changes; losing focus cancels the current job. */
  setFocused(focused: boolean): void;
  isFocused(): boolean;
  /** A job is running and still current (re-entrancy guard for new scans). */
  hasLiveJob(): boolean;
}

export function createScanLifecycle(initiallyFocused = true): ScanLifecycle {
  let focused = initiallyFocused;
  let generation = 0;
  let current: { generation: number; controller: AbortController } | null = null;

  const isLive = (gen: number) =>
    focused && current !== null && current.generation === gen && !current.controller.signal.aborted;

  const cancel = (): boolean => {
    if (!current) return false;
    current.controller.abort();
    current = null;
    generation += 1;
    return true;
  };

  return {
    begin() {
      if (!focused) return null;
      cancel();
      generation += 1;
      const controller = new AbortController();
      const gen = generation;
      current = { generation: gen, controller };
      return { generation: gen, signal: controller.signal, isCurrent: () => isLive(gen) };
    },
    end(job) {
      if (current && current.generation === job.generation) current = null;
    },
    cancel,
    setFocused(next) {
      focused = next;
      if (!next) cancel();
    },
    isFocused: () => focused,
    hasLiveJob: () => current !== null && isLive(current.generation),
  };
}

/** The slice of React Navigation's screen `navigation` object this needs. */
export interface FocusEventSource {
  addListener?: (event: 'focus' | 'blur', cb: () => void) => (() => void) | void;
  isFocused?: () => boolean;
}

/**
 * Wires a lifecycle to React Navigation's documented `focus` / `blur` screen events
 * (works for drawer switches, stack pushes and the close button's navigate on iOS,
 * Android and web). `onCancelled` runs when a blur actually cancelled a job, so the
 * screen can clear its busy UI. Returns the unsubscribe.
 */
export function bindScanLifecycleToNavigation(
  navigation: FocusEventSource | null | undefined,
  lifecycle: ScanLifecycle,
  onCancelled?: () => void,
): () => void {
  if (!navigation || typeof navigation.addListener !== 'function') return () => {};
  if (typeof navigation.isFocused === 'function') lifecycle.setFocused(navigation.isFocused());
  const offFocus = navigation.addListener('focus', () => lifecycle.setFocused(true));
  const offBlur = navigation.addListener('blur', () => {
    const hadJob = lifecycle.hasLiveJob();
    lifecycle.setFocused(false);
    if (hadJob) onCancelled?.();
  });
  return () => {
    if (typeof offFocus === 'function') offFocus();
    if (typeof offBlur === 'function') offBlur();
  };
}

/**
 * Wraps every method of a callback object (ScanFlowUi) so it is a no-op once `job` is no
 * longer current. Late results — the API answer, native OCR text, the fallback search —
 * all arrive through these callbacks, so a retired job can neither commit nor repaint.
 */
export function guardForJob<T extends object>(job: ScanJob, target: T): T {
  const guarded = {} as T;
  for (const key of Object.keys(target) as (keyof T)[]) {
    const value = target[key];
    guarded[key] = (typeof value === 'function'
      ? (...args: unknown[]) => (job.isCurrent() ? (value as (...a: unknown[]) => unknown)(...args) : undefined)
      : value) as T[keyof T];
  }
  return guarded;
}
