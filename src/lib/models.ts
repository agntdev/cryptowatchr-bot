/** Domain entities — durable shapes stored via the KV store. */

export interface ThresholdAlerts {
  above?: number;
  below?: number;
}

export interface PercentAlert {
  /** Absolute percent move that fires the alert (e.g. 5 = 5%). */
  percent: number;
  /** Lookback window in hours (e.g. 1 = 1h). */
  window_hours: number;
}

export interface UserProfile {
  telegram_id: number;
  display_name: string;
  timezone: string;
  quiet_hours_start: string | null; // "HH:MM" 24h local
  quiet_hours_end: string | null;
  summary_time: string | null; // "HH:MM"
  summary_enabled: boolean;
  created_at: number;
  /** Last time a morning summary was delivered (epoch ms). */
  last_summary_date?: string; // "YYYY-MM-DD" in user tz
}

export interface WatchlistItem {
  ticker: string; // uppercase symbol, e.g. "BTC"
  display_name: string;
  coingecko_id: string;
  threshold_alerts: ThresholdAlerts;
  percent_alerts: PercentAlert[];
  last_notified_price?: number;
  last_notified_time?: number;
  cooldown_threshold?: number; // epoch ms when threshold cooldown ends
  cooldown_percent?: number;
  /** Price sample for percent-window baseline. */
  window_price?: number;
  window_started_at?: number;
}

export interface WatchlistIndex {
  tickers: string[];
}

export interface QueuedAlert {
  id: string;
  ticker: string;
  display_name: string;
  kind: "threshold" | "percent";
  old_price: number;
  new_price: number;
  percent_change: number;
  detail: string;
  queued_at: number;
}

export interface AlertQueue {
  items: QueuedAlert[];
}

export interface GlobalStats {
  total_users: number;
  /** Explicit user-id index — never scan the keyspace. */
  user_ids: number[];
  /** Firing counts per ticker symbol. */
  alert_counts: Record<string, number>;
  /** Firing counts per alert kind. */
  alert_type_counts: Record<string, number>;
}

// ── key helpers (explicit, no scans) ──────────────────────────────

export const keys = {
  profile: (uid: number) => `user:profile:${uid}`,
  watchlist: (uid: number) => `user:watchlist:${uid}`,
  item: (uid: number, ticker: string) =>
    `user:item:${uid}:${ticker.toUpperCase()}`,
  queue: (uid: number) => `user:queue:${uid}`,
  stats: () => `global:stats`,
  /** Last-known price quote for a coin id (stale fallback). */
  priceCache: (coinId: string) => `price:cache:${coinId}`,
};

export const DEFAULT_QUIET_START = "22:00";
export const DEFAULT_QUIET_END = "08:00";
/** Cooldown between same-kind alerts (ms). */
export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
