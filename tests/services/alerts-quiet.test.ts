/**
 * Programmatic coverage for quiet-hours queueing, flush, morning summary,
 * and owner stats — paths that need a controlled clock.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { freezeAt, resetClock, now } from "../../src/lib/clock.js";
import { resetDurableStore } from "../../src/lib/store.js";
import { ensureProfile, getStats, saveProfile } from "../../src/services/users.js";
import { addTicker, getItem, saveItem } from "../../src/services/watchlist.js";
import {
  deliverMorningSummary,
  evaluateUserAlerts,
  flushQuietQueue,
} from "../../src/services/alerts.js";
import { COMMON_COINS } from "../../src/services/prices.js";

const NOON = Date.UTC(2026, 5, 15, 12, 0, 0);
const NIGHT = Date.UTC(2026, 5, 15, 23, 30, 0); // inside 22–08 quiet
const MORNING = Date.UTC(2026, 5, 16, 9, 0, 0);

beforeEach(() => {
  resetDurableStore();
  resetClock();
  freezeAt(NOON);
});

describe("quiet hours alert queue", () => {
  it("queues alerts during quiet hours and flushes after", async () => {
    const uid = 42;
    await ensureProfile(uid, "Tester");
    const profile = await ensureProfile(uid, "Tester");
    profile.quiet_hours_start = "22:00";
    profile.quiet_hours_end = "08:00";
    await saveProfile(profile);

    await addTicker(uid, COMMON_COINS[0]!);
    const item = await getItem(uid, "BTC");
    expect(item).toBeTruthy();
    item!.threshold_alerts = { above: 100 };
    await saveItem(uid, item!);

    freezeAt(NIGHT);
    const sent: string[] = [];
    const send = async (_chat: number, text: string) => {
      sent.push(text);
    };

    const fired = await evaluateUserAlerts(uid, send);
    expect(fired.length).toBeGreaterThan(0);
    expect(sent.length).toBe(0); // queued, not delivered

    freezeAt(NOON);
    const n = await flushQuietQueue(uid, send);
    expect(n).toBeGreaterThan(0);
    expect(sent.some((t) => t.includes("Quiet hours ended"))).toBe(true);
  });
});

describe("morning summary", () => {
  it("delivers at the configured local time once per day", async () => {
    const uid = 7;
    await ensureProfile(uid, "Sum");
    const profile = await ensureProfile(uid, "Sum");
    profile.summary_enabled = true;
    profile.summary_time = "09:00";
    profile.timezone = "UTC";
    await saveProfile(profile);
    await addTicker(uid, COMMON_COINS[1]!);

    freezeAt(MORNING);
    const sent: string[] = [];
    const text = await deliverMorningSummary(uid, async (_c, t) => {
      sent.push(t);
    });
    expect(text).toBeTruthy();
    expect(sent[0]).toContain("Morning summary");
    expect(sent[0]).toContain("ETH");

    // second call same day — suppressed
    const again = await deliverMorningSummary(uid, async (_c, t) => {
      sent.push(t);
    });
    expect(again).toBeNull();
    expect(sent.length).toBe(1);
  });
});

describe("global stats", () => {
  it("tracks total users via index", async () => {
    await ensureProfile(1, "A");
    await ensureProfile(2, "B");
    await ensureProfile(1, "A"); // idempotent
    const stats = await getStats();
    expect(stats.total_users).toBe(2);
    expect(stats.user_ids).toEqual([1, 2]);
  });
});

describe("clock seam", () => {
  it("now() returns frozen time", () => {
    freezeAt(1234567890);
    expect(now()).toBe(1234567890);
  });
});
