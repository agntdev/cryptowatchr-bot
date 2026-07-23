/**
 * Injectable clock seam — every schedule, cutoff, "today", expiry, and
 * late/on-time decision routes through now() so tests can drive time.
 */

let _now: () => number = () => Date.now();

/** Current wall-clock ms (overridable in tests). */
export function now(): number {
  return _now();
}

/** Override the clock (tests). */
export function setNow(fn: () => number): void {
  _now = fn;
}

/** Freeze the clock at a fixed epoch ms (tests). */
export function freezeAt(ms: number): void {
  _now = () => ms;
}

/** Restore the real system clock. */
export function resetClock(): void {
  _now = () => Date.now();
}
