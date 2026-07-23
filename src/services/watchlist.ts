import {
  keys,
  type ThresholdAlerts,
  type PercentAlert,
  type WatchlistIndex,
  type WatchlistItem,
} from "../lib/models.js";
import { storeDel, storeGet, storeSet } from "../lib/store.js";
import type { TickerInfo } from "./prices.js";

export async function getWatchlistIndex(uid: number): Promise<string[]> {
  const idx = await storeGet<WatchlistIndex>(keys.watchlist(uid));
  return idx?.tickers ?? [];
}

export async function getItem(
  uid: number,
  ticker: string,
): Promise<WatchlistItem | undefined> {
  return storeGet<WatchlistItem>(keys.item(uid, ticker));
}

export async function listItems(uid: number): Promise<WatchlistItem[]> {
  const tickers = await getWatchlistIndex(uid);
  const out: WatchlistItem[] = [];
  for (const t of tickers) {
    const item = await getItem(uid, t);
    if (item) out.push(item);
  }
  return out;
}

export async function addTicker(
  uid: number,
  info: TickerInfo,
): Promise<{ item: WatchlistItem; created: boolean }> {
  const symbol = info.symbol.toUpperCase();
  const existing = await getItem(uid, symbol);
  if (existing) return { item: existing, created: false };

  const item: WatchlistItem = {
    ticker: symbol,
    display_name: info.name,
    coingecko_id: info.id,
    threshold_alerts: {},
    percent_alerts: [],
  };
  await storeSet(keys.item(uid, symbol), item);

  const tickers = await getWatchlistIndex(uid);
  if (!tickers.includes(symbol)) {
    tickers.push(symbol);
    await storeSet(keys.watchlist(uid), { tickers } satisfies WatchlistIndex);
  }
  return { item, created: true };
}

export async function removeTicker(uid: number, ticker: string): Promise<boolean> {
  const symbol = ticker.toUpperCase();
  const tickers = await getWatchlistIndex(uid);
  const next = tickers.filter((t) => t !== symbol);
  if (next.length === tickers.length) return false;
  await storeSet(keys.watchlist(uid), { tickers: next } satisfies WatchlistIndex);
  await storeDel(keys.item(uid, symbol));
  return true;
}

export async function clearWatchlist(uid: number): Promise<number> {
  const tickers = await getWatchlistIndex(uid);
  for (const t of tickers) {
    await storeDel(keys.item(uid, t));
  }
  await storeSet(keys.watchlist(uid), { tickers: [] } satisfies WatchlistIndex);
  return tickers.length;
}

export async function saveItem(uid: number, item: WatchlistItem): Promise<void> {
  await storeSet(keys.item(uid, item.ticker), item);
}

export async function setThresholds(
  uid: number,
  ticker: string,
  alerts: ThresholdAlerts,
  mode: "merge" | "replace" = "merge",
): Promise<WatchlistItem | undefined> {
  const item = await getItem(uid, ticker);
  if (!item) return undefined;
  if (mode === "replace") {
    item.threshold_alerts = { ...alerts };
  } else {
    item.threshold_alerts = { ...item.threshold_alerts };
    if ("above" in alerts) {
      if (alerts.above === undefined) delete item.threshold_alerts.above;
      else item.threshold_alerts.above = alerts.above;
    }
    if ("below" in alerts) {
      if (alerts.below === undefined) delete item.threshold_alerts.below;
      else item.threshold_alerts.below = alerts.below;
    }
  }
  await saveItem(uid, item);
  return item;
}

export async function setPercentAlert(
  uid: number,
  ticker: string,
  alert: PercentAlert | null,
): Promise<WatchlistItem | undefined> {
  const item = await getItem(uid, ticker);
  if (!item) return undefined;
  item.percent_alerts = alert ? [alert] : [];
  item.window_price = undefined;
  item.window_started_at = undefined;
  await saveItem(uid, item);
  return item;
}

export function describeAlerts(item: WatchlistItem): string {
  const parts: string[] = [];
  const t = item.threshold_alerts;
  if (t.above != null) parts.push(`above $${t.above}`);
  if (t.below != null) parts.push(`below $${t.below}`);
  for (const p of item.percent_alerts) {
    parts.push(`${p.percent}% in ${p.window_hours}h`);
  }
  return parts.length ? parts.join(", ") : "no alerts set";
}
