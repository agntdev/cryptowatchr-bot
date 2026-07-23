/**
 * Multi-provider price feed with hardening for production outages.
 *
 * Primary: CoinGecko simple/price (+ optional COINGECKO_API_KEY)
 * Secondary: Binance 24hr ticker (public, no key)
 * Last resort: durable last-known cache (marked stale)
 *
 * Retries with jitter, per-provider circuit breakers, request timeouts, and a
 * short in-memory request cache keep schedulers and /price resilient when a
 * provider rate-limits or drops DNS.
 *
 * Network is unavailable in the test harness; under VITEST / harness offline
 * mode we serve a deterministic fixture table for known coins.
 */

import { now } from "../lib/clock.js";
import { keys } from "../lib/models.js";
import { storeGet, storeSet } from "../lib/store.js";

export interface PriceQuote {
  id: string;
  symbol: string;
  name: string;
  price_usd: number;
  change_24h: number | null;
  /** True when served from last-known cache after live providers failed. */
  stale?: boolean;
  /** Which layer produced the quote. */
  source?: "coingecko" | "binance" | "cache" | "fixture";
  /** Epoch ms when this price was observed (live or cache write). */
  as_of?: number;
}

export interface TickerInfo {
  id: string;
  symbol: string;
  name: string;
}

export interface FeedHealth {
  coingecko: ProviderHealth;
  binance: ProviderHealth;
  last_error?: string;
  last_success_at?: number;
  last_failure_at?: number;
}

interface ProviderHealth {
  state: "closed" | "open" | "half_open";
  failures: number;
  opened_at?: number;
  last_error?: string;
}

interface CachedQuote {
  id: string;
  symbol: string;
  name: string;
  price_usd: number;
  change_24h: number | null;
  as_of: number;
  source: "coingecko" | "binance";
}

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const COINGECKO_PRO_BASE = "https://pro-api.coingecko.com/api/v3";
const BINANCE = "https://api.binance.com/api/v3";

/** Request timeout per attempt (ms). */
const FETCH_TIMEOUT_MS = 8_000;
/** Max retries after the first attempt. */
const MAX_RETRIES = 2;
/** Circuit opens after this many consecutive provider failures. */
const CIRCUIT_FAILURE_THRESHOLD = 3;
/** How long the circuit stays open before a probe (ms). */
const CIRCUIT_COOLDOWN_MS = 60_000;
/** In-memory request consolidation TTL (ms). */
const MEM_CACHE_TTL_MS = 15_000;

/** Well-known coins for quick-add + offline test fallback. */
export const COMMON_COINS: ReadonlyArray<TickerInfo> = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "the-open-network", symbol: "TON", name: "Toncoin" },
];

const COMMON_BY_SYMBOL = new Map(
  COMMON_COINS.map((c) => [c.symbol.toUpperCase(), c]),
);

/** Offline fixtures used when VITEST is set or harness enables offline mode. */
const OFFLINE_PRICES: Record<string, { price: number; change: number }> = {
  bitcoin: { price: 67500.25, change: 1.42 },
  ethereum: { price: 3450.8, change: -0.65 },
  "the-open-network": { price: 5.42, change: 3.1 },
  solana: { price: 148.2, change: 2.05 },
  cardano: { price: 0.45, change: -1.2 },
  ripple: { price: 0.62, change: 0.8 },
  dogecoin: { price: 0.12, change: 4.5 },
};

const OFFLINE_SEARCH: Record<string, TickerInfo> = {
  BTC: COMMON_COINS[0]!,
  BITCOIN: COMMON_COINS[0]!,
  ETH: COMMON_COINS[1]!,
  ETHEREUM: COMMON_COINS[1]!,
  TON: COMMON_COINS[2]!,
  TONCOIN: COMMON_COINS[2]!,
  SOL: { id: "solana", symbol: "SOL", name: "Solana" },
  SOLANA: { id: "solana", symbol: "SOL", name: "Solana" },
  ADA: { id: "cardano", symbol: "ADA", name: "Cardano" },
  XRP: { id: "ripple", symbol: "XRP", name: "XRP" },
  DOGE: { id: "dogecoin", symbol: "DOGE", name: "Dogecoin" },
};

/** CoinGecko id → Binance USDT pair (secondary provider). */
const BINANCE_PAIR_BY_ID: Record<string, string> = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
  "the-open-network": "TONUSDT",
  solana: "SOLUSDT",
  cardano: "ADAUSDT",
  ripple: "XRPUSDT",
  dogecoin: "DOGEUSDT",
  "binancecoin": "BNBUSDT",
  litecoin: "LTCUSDT",
  polkadot: "DOTUSDT",
  "matic-network": "MATICUSDT",
  "avalanche-2": "AVAXUSDT",
  chainlink: "LINKUSDT",
  uniswap: "UNIUSDT",
  stellar: "XLMUSDT",
  "shiba-inu": "SHIBUSDT",
};

const ID_BY_BINANCE_BASE: Record<string, string> = Object.fromEntries(
  Object.entries(BINANCE_PAIR_BY_ID).map(([id, pair]) => [
    pair.replace(/USDT$/, ""),
    id,
  ]),
);

type FetchFn = typeof globalThis.fetch;
let fetchImpl: FetchFn = globalThis.fetch.bind(globalThis);
/** Forced offline mode (harness / tokenless gate without VITEST). */
let offlineMode = false;
/**
 * Force the multi-provider live path even under Vitest (unit tests that mock
 * fetch). Offline fixtures still win when offlineMode is true.
 */
let forceLive = false;

const providerHealth: Record<"coingecko" | "binance", ProviderHealth> = {
  coingecko: { state: "closed", failures: 0 },
  binance: { state: "closed", failures: 0 },
};

let lastFeedError: string | undefined;
let lastSuccessAt: number | undefined;
let lastFailureAt: number | undefined;

/** Short-lived in-memory quotes to consolidate concurrent requests. */
const memCache = new Map<string, { quote: PriceQuote; expires: number }>();

/** Inject fetch (tests). */
export function setPriceFetch(fn: FetchFn): void {
  fetchImpl = fn;
}

export function resetPriceFetch(): void {
  fetchImpl = globalThis.fetch.bind(globalThis);
  memCache.clear();
  forceLive = false;
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms));
  providerHealth.coingecko = { state: "closed", failures: 0 };
  providerHealth.binance = { state: "closed", failures: 0 };
  lastFeedError = undefined;
  lastSuccessAt = undefined;
  lastFailureAt = undefined;
}

/** Enable deterministic offline fixtures (harness-entry). */
export function setPriceOffline(enabled: boolean): void {
  offlineMode = enabled;
}

/** Unit tests: exercise real provider path with a mocked fetch. */
export function setPriceForceLive(enabled: boolean): void {
  forceLive = enabled;
  if (enabled) offlineMode = false;
}

export function getFeedHealth(): FeedHealth {
  return {
    coingecko: { ...providerHealth.coingecko },
    binance: { ...providerHealth.binance },
    last_error: lastFeedError,
    last_success_at: lastSuccessAt,
    last_failure_at: lastFailureAt,
  };
}

function isTestEnv(): boolean {
  if (forceLive) return false;
  if (offlineMode) return true;
  return typeof process !== "undefined" && Boolean(process.env.VITEST);
}

type SleepFn = (ms: number) => Promise<void>;
let sleepImpl: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test-only: replace sleep (e.g. no-op) so retry tests stay fast. */
export function setPriceSleep(fn: SleepFn | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

function sleep(ms: number): Promise<void> {
  return sleepImpl(ms);
}

/** Exponential backoff with full jitter (0 … base*2^attempt). */
function backoffMs(attempt: number): number {
  const base = 200 * Math.pow(2, attempt);
  // Deterministic half-jitter (no Math.random) so tests/workers stay stable.
  const jitter = Math.floor(base / 2);
  return Math.min(base + jitter, 2_500);
}

function circuitAllows(provider: "coingecko" | "binance"): boolean {
  const h = providerHealth[provider];
  if (h.state === "closed" || h.state === "half_open") return true;
  const opened = h.opened_at ?? 0;
  if (now() - opened >= CIRCUIT_COOLDOWN_MS) {
    h.state = "half_open";
    return true;
  }
  return false;
}

function recordSuccess(provider: "coingecko" | "binance"): void {
  providerHealth[provider] = { state: "closed", failures: 0 };
  lastSuccessAt = now();
}

function recordFailure(provider: "coingecko" | "binance", err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const h = providerHealth[provider];
  h.failures += 1;
  h.last_error = msg;
  lastFeedError = `${provider}: ${msg}`;
  lastFailureAt = now();
  if (h.failures >= CIRCUIT_FAILURE_THRESHOLD || h.state === "half_open") {
    h.state = "open";
    h.opened_at = now();
  }
}

function coingeckoConfig(): { base: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { accept: "application/json" };
  const key =
    typeof process !== "undefined" ? process.env.COINGECKO_API_KEY : undefined;
  const mode =
    typeof process !== "undefined"
      ? (process.env.COINGECKO_API_MODE ?? "demo").toLowerCase()
      : "demo";
  if (key) {
    if (mode === "pro") {
      headers["x-cg-pro-api-key"] = key;
      return { base: COINGECKO_PRO_BASE, headers };
    }
    headers["x-cg-demo-api-key"] = key;
  }
  return { base: COINGECKO_BASE, headers };
}

async function fetchJsonOnce<T>(
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    : null;
  try {
    const res = await fetchImpl(url, {
      headers,
      signal: controller?.signal,
    });
    if (res.status === 429) {
      throw new Error("HTTP 429 rate limited");
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch JSON with retries + jitter. Returns null on hard failure (does not throw).
 * Rate limits and 5xx are retried; 4xx (except 429) are not.
 */
async function fetchJsonWithRetry<T>(
  url: string,
  headers: Record<string, string>,
  retries = MAX_RETRIES,
): Promise<{ data: T | null; error?: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await fetchJsonOnce<T>(url, headers);
      return { data };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable =
        msg.includes("429") ||
        msg.includes("HTTP 5") ||
        msg.includes("abort") ||
        msg.includes("network") ||
        msg.includes("fetch") ||
        msg.includes("ECONN") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("Timeout");
      if (!retryable && msg.startsWith("HTTP 4")) {
        return { data: null, error: msg };
      }
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
      }
    }
  }
  return {
    data: null,
    error: lastErr instanceof Error ? lastErr.message : "Price feed unavailable",
  };
}

function offlineQuote(info: TickerInfo): PriceQuote {
  const p = OFFLINE_PRICES[info.id] ?? { price: 1, change: 0 };
  return {
    id: info.id,
    symbol: info.symbol.toUpperCase(),
    name: info.name,
    price_usd: p.price,
    change_24h: p.change,
    source: "fixture",
    as_of: now(),
  };
}

function tickerInfoForId(id: string): TickerInfo {
  return (
    COMMON_COINS.find((c) => c.id === id) ??
    Object.values(OFFLINE_SEARCH).find((c) => c.id === id) ?? {
      id,
      symbol: (id.split("-")[0] ?? id).slice(0, 6).toUpperCase(),
      name: id,
    }
  );
}

async function readCache(id: string): Promise<PriceQuote | null> {
  const cached = await storeGet<CachedQuote>(keys.priceCache(id));
  if (!cached || typeof cached.price_usd !== "number") return null;
  return {
    id: cached.id,
    symbol: cached.symbol,
    name: cached.name,
    price_usd: cached.price_usd,
    change_24h: cached.change_24h,
    stale: true,
    source: "cache",
    as_of: cached.as_of,
  };
}

async function writeCache(quote: PriceQuote, source: "coingecko" | "binance"): Promise<void> {
  const entry: CachedQuote = {
    id: quote.id,
    symbol: quote.symbol,
    name: quote.name,
    price_usd: quote.price_usd,
    change_24h: quote.change_24h,
    as_of: quote.as_of ?? now(),
    source,
  };
  try {
    await storeSet(keys.priceCache(quote.id), entry);
  } catch {
    // cache write is best-effort — never break price delivery
  }
  memCache.set(quote.id, {
    quote: { ...quote, stale: false, source },
    expires: now() + MEM_CACHE_TTL_MS,
  });
}

function memGet(id: string): PriceQuote | null {
  const hit = memCache.get(id);
  if (!hit) return null;
  if (hit.expires < now()) {
    memCache.delete(id);
    return null;
  }
  return { ...hit.quote };
}

async function fetchFromCoinGecko(
  ids: string[],
): Promise<Map<string, PriceQuote>> {
  const out = new Map<string, PriceQuote>();
  if (!circuitAllows("coingecko") || ids.length === 0) return out;

  const { base, headers } = coingeckoConfig();
  const chunkSize = 50;
  let anySuccess = false;
  let lastErr: string | undefined;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const url =
      `${base}/simple/price?ids=${encodeURIComponent(chunk.join(","))}` +
      `&vs_currencies=usd&include_24hr_change=true`;

    type Raw = Record<string, { usd?: number; usd_24h_change?: number }>;
    const { data, error } = await fetchJsonWithRetry<Raw>(url, headers);
    if (!data) {
      lastErr = error ?? "CoinGecko request failed";
      continue;
    }
    anySuccess = true;
    for (const id of chunk) {
      const row = data[id];
      if (!row || typeof row.usd !== "number") continue;
      const info = tickerInfoForId(id);
      const quote: PriceQuote = {
        id,
        symbol: info.symbol.toUpperCase(),
        name: info.name,
        price_usd: row.usd,
        change_24h:
          typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
        source: "coingecko",
        as_of: now(),
      };
      out.set(id, quote);
      await writeCache(quote, "coingecko");
    }
  }

  if (anySuccess) {
    recordSuccess("coingecko");
  } else if (lastErr) {
    recordFailure("coingecko", new Error(lastErr));
  }
  return out;
}

async function fetchFromBinance(ids: string[]): Promise<Map<string, PriceQuote>> {
  const out = new Map<string, PriceQuote>();
  if (!circuitAllows("binance") || ids.length === 0) return out;

  let anySuccess = false;
  let lastErr: string | undefined;

  // Binance allows multi-symbol via symbols= JSON array
  const pairs: Array<{ id: string; pair: string }> = [];
  for (const id of ids) {
    const pair = BINANCE_PAIR_BY_ID[id];
    if (pair) pairs.push({ id, pair });
  }
  if (pairs.length === 0) return out;

  // Batch when possible; fall back to per-symbol on failure
  const symbolsParam = encodeURIComponent(
    JSON.stringify(pairs.map((p) => p.pair)),
  );
  const batchUrl = `${BINANCE}/ticker/24hr?symbols=${symbolsParam}`;
  type BinanceRow = {
    symbol?: string;
    lastPrice?: string;
    priceChangePercent?: string;
  };

  const { data: batch, error: batchErr } = await fetchJsonWithRetry<
    BinanceRow[] | BinanceRow
  >(batchUrl, { accept: "application/json" });

  const rows: BinanceRow[] = Array.isArray(batch)
    ? batch
    : batch
      ? [batch]
      : [];

  if (rows.length > 0) {
    anySuccess = true;
    const byPair = new Map(
      rows
        .filter((r) => r.symbol)
        .map((r) => [r.symbol!.toUpperCase(), r] as const),
    );
    for (const { id, pair } of pairs) {
      const row = byPair.get(pair);
      if (!row?.lastPrice) continue;
      const price = Number(row.lastPrice);
      if (!Number.isFinite(price)) continue;
      const change = row.priceChangePercent
        ? Number(row.priceChangePercent)
        : null;
      const info = tickerInfoForId(id);
      const quote: PriceQuote = {
        id,
        symbol: info.symbol.toUpperCase(),
        name: info.name,
        price_usd: price,
        change_24h: change != null && Number.isFinite(change) ? change : null,
        source: "binance",
        as_of: now(),
      };
      out.set(id, quote);
      await writeCache(quote, "binance");
    }
  } else {
    // Per-symbol fallback (some environments reject the multi-symbol form)
    lastErr = batchErr;
    for (const { id, pair } of pairs) {
      const url = `${BINANCE}/ticker/24hr?symbol=${pair}`;
      const { data, error } = await fetchJsonWithRetry<BinanceRow>(url, {
        accept: "application/json",
      });
      if (!data?.lastPrice) {
        lastErr = error ?? lastErr;
        continue;
      }
      const price = Number(data.lastPrice);
      if (!Number.isFinite(price)) continue;
      anySuccess = true;
      const change = data.priceChangePercent
        ? Number(data.priceChangePercent)
        : null;
      const info = tickerInfoForId(id);
      const quote: PriceQuote = {
        id,
        symbol: info.symbol.toUpperCase(),
        name: info.name,
        price_usd: price,
        change_24h: change != null && Number.isFinite(change) ? change : null,
        source: "binance",
        as_of: now(),
      };
      out.set(id, quote);
      await writeCache(quote, "binance");
    }
  }

  if (anySuccess) {
    recordSuccess("binance");
  } else if (lastErr) {
    recordFailure("binance", new Error(lastErr));
  }
  return out;
}

/**
 * Resolve a user-entered symbol/name to a CoinGecko-style coin id.
 * Tries common map first, then the search endpoint, then known Binance bases.
 */
export async function resolveTicker(input: string): Promise<TickerInfo | null> {
  const raw = input.trim();
  if (!raw || raw.length > 40) return null;
  const upper = raw.toUpperCase();

  const common = COMMON_BY_SYMBOL.get(upper);
  if (common) return common;

  if (isTestEnv()) {
    return OFFLINE_SEARCH[upper] ?? null;
  }

  // Known offline/search table before network
  if (OFFLINE_SEARCH[upper]) return OFFLINE_SEARCH[upper]!;

  // CoinGecko search
  if (circuitAllows("coingecko")) {
    const { base, headers } = coingeckoConfig();
    const { data, error } = await fetchJsonWithRetry<{
      coins?: Array<{
        id: string;
        symbol: string;
        name: string;
        market_cap_rank?: number | null;
      }>;
    }>(`${base}/search?query=${encodeURIComponent(raw)}`, headers);

    if (data?.coins?.length) {
      recordSuccess("coingecko");
      const exact = data.coins.find((c) => c.symbol.toUpperCase() === upper);
      const pick =
        exact ??
        [...data.coins].sort(
          (a, b) => (a.market_cap_rank ?? 99999) - (b.market_cap_rank ?? 99999),
        )[0];
      if (pick) {
        return {
          id: pick.id,
          symbol: pick.symbol.toUpperCase(),
          name: pick.name,
        };
      }
    } else if (error) {
      recordFailure("coingecko", new Error(error));
    }
  }

  // Binance base-asset fallback for well-known symbols
  const binanceId = ID_BY_BINANCE_BASE[upper];
  if (binanceId) {
    const info = tickerInfoForId(binanceId);
    return { id: binanceId, symbol: info.symbol, name: info.name };
  }

  // exact common name fallback
  const byName = COMMON_COINS.find(
    (c) => c.name.toUpperCase() === upper || c.id === raw.toLowerCase(),
  );
  return byName ?? null;
}

/**
 * Fetch USD price + 24h change for one or more coin ids.
 * Never throws on provider outage — fills from secondary then cache.
 * Throws only in non-test env when *no* ids can be resolved and no cache
 * exists (callers may still catch and show a friendly message).
 */
export async function fetchPrices(
  ids: string[],
): Promise<Map<string, PriceQuote>> {
  const out = new Map<string, PriceQuote>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;

  // Vitest / harness: never hit the network. Use fixtures.
  if (isTestEnv()) {
    for (const id of unique) {
      const info = tickerInfoForId(id);
      out.set(id, offlineQuote(info));
    }
    return out;
  }

  const missing: string[] = [];
  for (const id of unique) {
    const hit = memGet(id);
    if (hit) out.set(id, hit);
    else missing.push(id);
  }
  if (missing.length === 0) return out;

  // Primary
  const primary = await fetchFromCoinGecko(missing);
  for (const [id, q] of primary) {
    out.set(id, q);
  }

  const stillMissing = missing.filter((id) => !out.has(id));

  // Secondary
  if (stillMissing.length > 0) {
    const secondary = await fetchFromBinance(stillMissing);
    for (const [id, q] of secondary) {
      out.set(id, q);
    }
  }

  // Durable last-known cache (stale)
  const finalMissing = missing.filter((id) => !out.has(id));
  for (const id of finalMissing) {
    const cached = await readCache(id);
    if (cached) out.set(id, cached);
  }

  // If still empty for every requested id, surface a clear error so handlers
  // can tell the user — schedulers catch this and continue.
  if (out.size === 0 && unique.length > 0) {
    const err = lastFeedError ?? "Price feed unavailable";
    throw new Error(err);
  }

  return out;
}

export async function fetchPrice(id: string): Promise<PriceQuote | null> {
  try {
    const map = await fetchPrices([id]);
    return map.get(id) ?? null;
  } catch {
    // Last-ditch cache read if fetchPrices threw
    return readCache(id);
  }
}

/** Format a quote line suffix when data is stale. */
export function staleSuffix(quote: PriceQuote): string {
  return quote.stale ? " · last known" : "";
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // Pure deterministic formatting (no locale tables — Workers/Node parity).
  const abs = Math.abs(n);
  const decimals = abs >= 1 ? 2 : 6;
  const sign = n < 0 ? "-" : "";
  let body = abs.toFixed(decimals);
  if (decimals === 6) {
    body = body.replace(/0+$/, "").replace(/\.$/, "");
    if (!body.includes(".")) body += ".00";
    else {
      const frac = body.split(".")[1] ?? "";
      if (frac.length < 2) body = abs.toFixed(2);
    }
  }
  const [intPart, fracPart = "00"] = body.split(".");
  const withCommas = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${sign}${withCommas}.${fracPart}`;
}

export function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
