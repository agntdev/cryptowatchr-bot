import { now } from "./clock.js";

/** Parse "HH:MM" into minutes since midnight. Returns null if invalid. */
export function parseHHMM(text: string): { h: number; m: number; minutes: number } | null {
  const t = text.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min, minutes: h * 60 + min };
}

/** Format minutes since midnight as "HH:MM". */
export function formatHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Minutes since midnight in a given IANA timezone (falls back to UTC).
 */
export function localMinutes(tz: string, atMs: number = now()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(atMs));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return h * 60 + m;
  } catch {
    const d = new Date(atMs);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

/** Local calendar date "YYYY-MM-DD" in timezone. */
export function localDate(tz: string, atMs: number = now()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(atMs));
  } catch {
    return new Date(atMs).toISOString().slice(0, 10);
  }
}

/**
 * Quiet hours window may wrap midnight (e.g. 22:00–08:00).
 * Returns true when `minutes` falls inside [start, end) with wrap support.
 */
export function inQuietHours(
  minutes: number,
  startHHMM: string | null,
  endHHMM: string | null,
): boolean {
  if (!startHHMM || !endHHMM) return false;
  const s = parseHHMM(startHHMM);
  const e = parseHHMM(endHHMM);
  if (!s || !e) return false;
  if (s.minutes === e.minutes) return false; // disabled / zero-width
  if (s.minutes < e.minutes) {
    return minutes >= s.minutes && minutes < e.minutes;
  }
  // wraps midnight
  return minutes >= s.minutes || minutes < e.minutes;
}

/** True when local time matches summary_time within the same minute. */
export function isSummaryDue(
  summaryTime: string | null,
  tz: string,
  lastDate: string | undefined,
  atMs: number = now(),
): boolean {
  if (!summaryTime) return false;
  const t = parseHHMM(summaryTime);
  if (!t) return false;
  const mins = localMinutes(tz, atMs);
  if (mins !== t.minutes) return false;
  const today = localDate(tz, atMs);
  return lastDate !== today;
}
