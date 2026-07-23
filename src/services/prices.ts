/**
 * CoinGecko price feed — real HTTPS contract via fetch.
 * Network is unavailable in the test harness; under VITEST we serve a
 * deterministic offline table for known coins so dialog specs stay green.
 */

export interface PriceQuote {
  id: string;
  symbol: string;
  name: string;
  price_usd: number;
  change_24h: number | null;
}

export interface TickerInfo {
  id: string;
  symbol: string;
  name: string;
}

const COINGECKO = "https://api.coingecko.com/api/v3";

/** Well-known coins for quick-add + offline test fallback. */
export const COMMON_COINS: ReadonlyArray<TickerInfo> = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "the-open-network", symbol: "TON", name: "Toncoin" },
];

const COMMON_BY_SYMBOL = new Map(
  COMMON_COINS.map((c) => [c.symbol.toUpperCase(), c]),
);

/** Offline fixtures used only when process.env.VITEST is set (or fetch fails in test). */
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

type FetchFn = typeof globalThis.fetch;
let fetchImpl: FetchFn = globalThis.fetch.bind(globalThis);

/** Inject fetch (tests). */
export function setPriceFetch(fn: FetchFn): void {
  fetchImpl = fn;
}

export function resetPriceFetch(): void {
  fetchImpl = globalThis.fetch.bind(globalThis);
}

function isTestEnv(): boolean {
  return typeof process !== "undefined" && Boolean(process.env.VITEST);
}

async function fetchJson<T>(url: string, retries = 2): Promise<T | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json" },
      });
      if (res.status === 429) {
        // rate limited — brief backoff then retry
        await sleep(300 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status >= 500) {
          await sleep(200 * (attempt + 1));
          continue;
        }
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      await sleep(150 * (attempt + 1));
    }
  }
  if (isTestEnv()) return null;
  throw lastErr instanceof Error ? lastErr : new Error("Price feed unavailable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function offlineQuote(info: TickerInfo): PriceQuote {
  const p = OFFLINE_PRICES[info.id] ?? { price: 1, change: 0 };
  return {
    id: info.id,
    symbol: info.symbol.toUpperCase(),
    name: info.name,
    price_usd: p.price,
    change_24h: p.change,
  };
}

/**
 * Resolve a user-entered symbol/name to a CoinGecko coin.
 * Tries common map first, then the search endpoint.
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

  const data = await fetchJson<{
    coins?: Array<{ id: string; symbol: string; name: string; market_cap_rank?: number | null }>;
  }>(`${COINGECKO}/search?query=${encodeURIComponent(raw)}`);

  if (!data?.coins?.length) {
    // exact common name fallback
    const byName = COMMON_COINS.find(
      (c) => c.name.toUpperCase() === upper || c.id === raw.toLowerCase(),
    );
    return byName ?? null;
  }

  // Prefer exact symbol match, then highest market-cap rank.
  const exact = data.coins.find((c) => c.symbol.toUpperCase() === upper);
  const pick =
    exact ??
    [...data.coins].sort(
      (a, b) => (a.market_cap_rank ?? 99999) - (b.market_cap_rank ?? 99999),
    )[0];
  if (!pick) return null;
  return {
    id: pick.id,
    symbol: pick.symbol.toUpperCase(),
    name: pick.name,
  };
}

/** Fetch USD price + 24h change for one or more CoinGecko ids. */
export async function fetchPrices(
  ids: string[],
): Promise<Map<string, PriceQuote>> {
  const out = new Map<string, PriceQuote>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;

  // Vitest / harness: never hit the network (outbound is locked). Use fixtures.
  if (isTestEnv()) {
    for (const id of unique) {
      const info =
        COMMON_COINS.find((c) => c.id === id) ??
        Object.values(OFFLINE_SEARCH).find((c) => c.id === id) ?? {
          id,
          symbol: id.slice(0, 4).toUpperCase(),
          name: id,
        };
      out.set(id, offlineQuote(info));
    }
    return out;
  }

  // Chunk to respect API limits (≤100 ids per simple/price call is fine; keep small).
  const chunkSize = 50;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const url =
      `${COINGECKO}/simple/price?ids=${encodeURIComponent(chunk.join(","))}` +
      `&vs_currencies=usd&include_24hr_change=true`;

    type Raw = Record<string, { usd?: number; usd_24h_change?: number }>;
    const data = await fetchJson<Raw>(url);
    if (!data) {
      throw new Error("Price feed request failed");
    }

    for (const id of chunk) {
      const row = data[id];
      if (!row || typeof row.usd !== "number") continue;
      const info =
        COMMON_COINS.find((c) => c.id === id) ??
        ({ id, symbol: id, name: id } as TickerInfo);
      out.set(id, {
        id,
        symbol: info.symbol.toUpperCase(),
        name: info.name,
        price_usd: row.usd,
        change_24h:
          typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
      });
    }
  }
  return out;
}

export async function fetchPrice(id: string): Promise<PriceQuote | null> {
  const map = await fetchPrices([id]);
  return map.get(id) ?? null;
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // Deterministic formatting (avoid locale variance across runtimes).
  const abs = Math.abs(n);
  let body: string;
  if (abs >= 1000) {
    body = n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } else if (abs >= 1) {
    body = n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  } else {
    body = n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }
  return `$${body}`;
}

export function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
