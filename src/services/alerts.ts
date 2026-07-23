/**
 * Alert evaluation, quiet-hours queueing, morning summaries, and stats.
 * Delivery is best-effort: a 403 (blocked bot) never aborts the loop.
 */

import { now } from "../lib/clock.js";
import {
  DEFAULT_COOLDOWN_MS,
  keys,
  type AlertQueue,
  type QueuedAlert,
  type UserProfile,
  type WatchlistItem,
} from "../lib/models.js";
import { storeGet, storeSet } from "../lib/store.js";
import { inQuietHours, isSummaryDue, localMinutes } from "../lib/time.js";
import {
  fetchPrices,
  formatPct,
  formatUsd,
  staleSuffix,
  type PriceQuote,
} from "./prices.js";
import { getProfile, getStats, saveProfile, saveStats } from "./users.js";
import { listItems, saveItem } from "./watchlist.js";

export interface FiredAlert {
  ticker: string;
  display_name: string;
  kind: "threshold" | "percent";
  old_price: number;
  new_price: number;
  percent_change: number;
  detail: string;
}

export type SendFn = (chatId: number, text: string) => Promise<void>;

function pctChange(from: number, to: number): number {
  if (!from) return 0;
  return ((to - from) / from) * 100;
}

function alertMessage(a: FiredAlert): string {
  return (
    `Alert: ${a.display_name} (${a.ticker})\n` +
    `${formatUsd(a.old_price)} → ${formatUsd(a.new_price)} (${formatPct(a.percent_change)})\n` +
    a.detail
  );
}

async function getQueue(uid: number): Promise<AlertQueue> {
  return (await storeGet<AlertQueue>(keys.queue(uid))) ?? { items: [] };
}

async function saveQueue(uid: number, q: AlertQueue): Promise<void> {
  await storeSet(keys.queue(uid), q);
}

async function recordStat(ticker: string, kind: string): Promise<void> {
  const stats = await getStats();
  stats.alert_counts[ticker] = (stats.alert_counts[ticker] ?? 0) + 1;
  stats.alert_type_counts[kind] = (stats.alert_type_counts[kind] ?? 0) + 1;
  await saveStats(stats);
}

function evaluateItem(item: WatchlistItem, quote: PriceQuote, at: number): FiredAlert[] {
  const fired: FiredAlert[] = [];
  const price = quote.price_usd;
  const last = item.last_notified_price ?? item.window_price ?? price;

  // Thresholds
  const th = item.threshold_alerts;
  const thCool = item.cooldown_threshold ?? 0;
  if (at >= thCool) {
    if (th.above != null && price >= th.above) {
      fired.push({
        ticker: item.ticker,
        display_name: item.display_name,
        kind: "threshold",
        old_price: last,
        new_price: price,
        percent_change: pctChange(last, price),
        detail: `Crossed your above threshold of ${formatUsd(th.above)}.`,
      });
    } else if (th.below != null && price <= th.below) {
      fired.push({
        ticker: item.ticker,
        display_name: item.display_name,
        kind: "threshold",
        old_price: last,
        new_price: price,
        percent_change: pctChange(last, price),
        detail: `Crossed your below threshold of ${formatUsd(th.below)}.`,
      });
    }
  }

  // Percent-change windows
  const pctCool = item.cooldown_percent ?? 0;
  if (at >= pctCool && item.percent_alerts.length > 0) {
    const rule = item.percent_alerts[0]!;
    const windowMs = rule.window_hours * 60 * 60 * 1000;
    if (item.window_price == null || item.window_started_at == null) {
      item.window_price = price;
      item.window_started_at = at;
    } else if (at - item.window_started_at >= windowMs) {
      // window elapsed — reset baseline
      item.window_price = price;
      item.window_started_at = at;
    } else {
      const change = Math.abs(pctChange(item.window_price, price));
      if (change >= rule.percent) {
        fired.push({
          ticker: item.ticker,
          display_name: item.display_name,
          kind: "percent",
          old_price: item.window_price,
          new_price: price,
          percent_change: pctChange(item.window_price, price),
          detail: `Moved ${formatPct(pctChange(item.window_price, price))} within ${rule.window_hours}h (threshold ${rule.percent}%).`,
        });
        item.window_price = price;
        item.window_started_at = at;
      }
    }
  }

  return fired;
}

async function deliverOrQueue(
  uid: number,
  profile: UserProfile,
  alerts: FiredAlert[],
  send: SendFn,
): Promise<void> {
  if (alerts.length === 0) return;
  const mins = localMinutes(profile.timezone);
  const quiet = inQuietHours(mins, profile.quiet_hours_start, profile.quiet_hours_end);

  if (quiet) {
    const q = await getQueue(uid);
    for (const a of alerts) {
      const item: QueuedAlert = {
        id: `${a.ticker}-${a.kind}-${now()}`,
        ticker: a.ticker,
        display_name: a.display_name,
        kind: a.kind,
        old_price: a.old_price,
        new_price: a.new_price,
        percent_change: a.percent_change,
        detail: a.detail,
        queued_at: now(),
      };
      q.items.push(item);
      await recordStat(a.ticker, a.kind);
    }
    await saveQueue(uid, q);
    return;
  }

  for (const a of alerts) {
    try {
      await send(uid, alertMessage(a));
      await recordStat(a.ticker, a.kind);
    } catch {
      // 403 / blocked — skip, continue
    }
  }
}

/** Evaluate all watchlist items for one user against live prices. */
export async function evaluateUserAlerts(
  uid: number,
  send: SendFn,
): Promise<FiredAlert[]> {
  const profile = await getProfile(uid);
  if (!profile) return [];
  const items = await listItems(uid);
  if (items.length === 0) return [];

  const ids = items.map((i) => i.coingecko_id);
  let quotes: Map<string, PriceQuote>;
  try {
    // fetchPrices already falls back to Binance + last-known cache.
    quotes = await fetchPrices(ids);
  } catch {
    // Total feed outage with no cache — skip this tick; do not crash scheduler.
    return [];
  }

  const at = now();
  const allFired: FiredAlert[] = [];

  for (const item of items) {
    const quote = quotes.get(item.coingecko_id);
    if (!quote) continue;
    const fired = evaluateItem(item, quote, at);
    if (fired.length) {
      allFired.push(...fired);
      item.last_notified_price = quote.price_usd;
      item.last_notified_time = at;
      for (const f of fired) {
        if (f.kind === "threshold") {
          item.cooldown_threshold = at + DEFAULT_COOLDOWN_MS;
        } else {
          item.cooldown_percent = at + DEFAULT_COOLDOWN_MS;
        }
      }
    } else if (item.window_price == null) {
      item.window_price = quote.price_usd;
      item.window_started_at = at;
    }
    await saveItem(uid, item);
  }

  await deliverOrQueue(uid, profile, allFired, send);
  return allFired;
}

/** Flush queued quiet-hours alerts when the quiet window has ended. */
export async function flushQuietQueue(uid: number, send: SendFn): Promise<number> {
  const profile = await getProfile(uid);
  if (!profile) return 0;
  const mins = localMinutes(profile.timezone);
  if (inQuietHours(mins, profile.quiet_hours_start, profile.quiet_hours_end)) {
    return 0;
  }
  const q = await getQueue(uid);
  if (q.items.length === 0) return 0;

  const lines = q.items.map(
    (a) =>
      `• ${a.display_name} (${a.ticker}): ${formatUsd(a.old_price)} → ${formatUsd(a.new_price)} (${formatPct(a.percent_change)})`,
  );
  const text =
    `Quiet hours ended — ${q.items.length} alert${q.items.length === 1 ? "" : "s"} while you were away:\n` +
    lines.join("\n");
  try {
    await send(uid, text);
  } catch {
    // keep queue for next attempt
    return 0;
  }
  const n = q.items.length;
  await saveQueue(uid, { items: [] });
  return n;
}

/** Build and optionally send the morning summary for one user. */
export async function deliverMorningSummary(
  uid: number,
  send: SendFn,
  force = false,
): Promise<string | null> {
  const profile = await getProfile(uid);
  if (!profile) return null;
  if (!force) {
    if (!profile.summary_enabled) return null;
    if (
      !isSummaryDue(
        profile.summary_time,
        profile.timezone,
        profile.last_summary_date,
      )
    ) {
      return null;
    }
  }

  const items = await listItems(uid);
  if (items.length === 0) {
    const empty = "Morning summary: your watchlist is empty. Tap Add to track a coin.";
    if (!force) {
      try {
        await send(uid, empty);
      } catch {
        /* blocked */
      }
      profile.last_summary_date = new Date(now()).toISOString().slice(0, 10);
      // use local date
      const { localDate } = await import("../lib/time.js");
      profile.last_summary_date = localDate(profile.timezone);
      await saveProfile(profile);
    }
    return empty;
  }

  let quotes: Map<string, PriceQuote>;
  try {
    quotes = await fetchPrices(items.map((i) => i.coingecko_id));
  } catch {
    // Total outage — still acknowledge the summary slot so we don't spam retries.
    const outage =
      "Morning summary: price feed is unavailable right now. I'll retry next cycle.";
    if (!force) {
      try {
        await send(uid, outage);
      } catch {
        /* blocked */
      }
      const { localDate } = await import("../lib/time.js");
      profile.last_summary_date = localDate(profile.timezone);
      await saveProfile(profile);
    }
    return outage;
  }

  const lines: string[] = ["Morning summary"];
  for (const item of items) {
    const q = quotes.get(item.coingecko_id);
    if (!q) {
      lines.push(`• ${item.ticker}: price unavailable`);
      continue;
    }
    const move =
      q.change_24h != null && Math.abs(q.change_24h) >= 3
        ? ` — notable ${formatPct(q.change_24h)} 24h`
        : "";
    lines.push(
      `• ${item.display_name} (${item.ticker}): ${formatUsd(q.price_usd)}${staleSuffix(q)} (${formatPct(q.change_24h)})${move}`,
    );
  }
  const text = lines.join("\n");

  if (!force) {
    try {
      await send(uid, text);
    } catch {
      return null;
    }
    const { localDate } = await import("../lib/time.js");
    profile.last_summary_date = localDate(profile.timezone);
    await saveProfile(profile);
  }
  return text;
}

/**
 * Full tick for all known users: flush queues, evaluate alerts, morning summaries.
 * Tolerates per-user send failures (403) without aborting.
 */
export async function runAlertTick(send: SendFn): Promise<void> {
  const stats = await getStats();
  for (const uid of stats.user_ids) {
    try {
      await flushQuietQueue(uid, send);
      await evaluateUserAlerts(uid, send);
      await deliverMorningSummary(uid, send);
    } catch {
      // continue other users
    }
  }
}

export { alertMessage };
