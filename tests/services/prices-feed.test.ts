/**
 * Price-feed hardening: primary outage → Binance fallback → stale cache,
 * circuit breaker, and scheduler-safe empty results.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freezeAt, resetClock } from "../../src/lib/clock.js";
import { resetDurableStore, storeSet } from "../../src/lib/store.js";
import { keys } from "../../src/lib/models.js";
import {
  fetchPrice,
  fetchPrices,
  getFeedHealth,
  resetPriceFetch,
  setPriceFetch,
  setPriceForceLive,
  setPriceOffline,
  setPriceSleep,
  staleSuffix,
  type PriceQuote,
} from "../../src/services/prices.js";

const NOON = Date.UTC(2026, 5, 15, 12, 0, 0);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetDurableStore();
  resetClock();
  freezeAt(NOON);
  resetPriceFetch();
  // Force multi-provider path with mocked fetch (bypass Vitest fixtures).
  setPriceForceLive(true);
  // Skip real backoff delays so the suite stays fast.
  setPriceSleep(async () => undefined);
});

afterEach(() => {
  resetPriceFetch();
  setPriceOffline(true);
});

describe("price feed fallback", () => {
  it("falls back to Binance when CoinGecko fails", async () => {
    setPriceFetch(async (input) => {
      const url = String(input);
      if (url.includes("coingecko.com") || url.includes("pro-api.coingecko")) {
        return jsonResponse({ error: "down" }, 503);
      }
      if (url.includes("binance.com") && url.includes("ticker/24hr")) {
        if (url.includes("symbols=")) {
          return jsonResponse([
            {
              symbol: "BTCUSDT",
              lastPrice: "64000.50",
              priceChangePercent: "-1.25",
            },
          ]);
        }
        return jsonResponse({
          symbol: "BTCUSDT",
          lastPrice: "64000.50",
          priceChangePercent: "-1.25",
        });
      }
      return jsonResponse({}, 404);
    });

    const map = await fetchPrices(["bitcoin"]);
    const q = map.get("bitcoin");
    expect(q).toBeTruthy();
    expect(q!.price_usd).toBeCloseTo(64000.5);
    expect(q!.source).toBe("binance");
    expect(q!.stale).toBeFalsy();
    expect(getFeedHealth().binance.state).toBe("closed");
  });

  it("serves last-known cache marked stale when both providers fail", async () => {
    await storeSet(keys.priceCache("bitcoin"), {
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      price_usd: 67111.11,
      change_24h: 0.5,
      as_of: NOON - 60_000,
      source: "coingecko",
    });

    setPriceFetch(async () => jsonResponse({ error: "down" }, 503));

    const map = await fetchPrices(["bitcoin"]);
    const q = map.get("bitcoin")!;
    expect(q.price_usd).toBeCloseTo(67111.11);
    expect(q.stale).toBe(true);
    expect(q.source).toBe("cache");
    expect(staleSuffix(q)).toBe(" · last known");
  });

  it("throws only when live providers fail and no cache exists", async () => {
    setPriceFetch(async () => jsonResponse({ error: "down" }, 503));
    await expect(fetchPrices(["bitcoin"])).rejects.toThrow();
    const lone = await fetchPrice("bitcoin");
    expect(lone).toBeNull();
  });

  it("opens the CoinGecko circuit after consecutive failures then uses Binance", async () => {
    let geckoHits = 0;
    setPriceFetch(async (input) => {
      const url = String(input);
      if (url.includes("coingecko")) {
        geckoHits += 1;
        return jsonResponse({ error: "down" }, 503);
      }
      if (url.includes("binance.com")) {
        return jsonResponse({
          symbol: "ETHUSDT",
          lastPrice: "3000",
          priceChangePercent: "1.0",
        });
      }
      return jsonResponse({}, 404);
    });

    // Trip the circuit (threshold = 3 consecutive failures).
    for (let i = 0; i < 3; i++) {
      await fetchPrices(["ethereum"]).catch(() => undefined);
      // Clear mem cache between attempts by resetting only mem via time jump
      freezeAt(NOON + (i + 1) * 20_000);
    }

    const health = getFeedHealth();
    expect(health.coingecko.state).toBe("open");

    const before = geckoHits;
    freezeAt(NOON + 30_000);
    // Circuit open → CoinGecko skipped, Binance serves.
    const map = await fetchPrices(["ethereum"]);
    expect(map.get("ethereum")?.source).toBe("binance");
    // No additional CoinGecko hits while circuit is open (before cooldown).
    expect(geckoHits).toBe(before);
  });

  it("retries on 429 then succeeds", async () => {
    let attempts = 0;
    setPriceFetch(async (input) => {
      const url = String(input);
      if (!url.includes("coingecko")) return jsonResponse({}, 404);
      attempts += 1;
      if (attempts < 2) return jsonResponse({ status: { error_code: 429 } }, 429);
      return jsonResponse({
        bitcoin: { usd: 65000, usd_24h_change: 2.5 },
      });
    });

    const q = (await fetchPrices(["bitcoin"])).get("bitcoin")!;
    expect(q.price_usd).toBe(65000);
    expect(q.source).toBe("coingecko");
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it("staleSuffix is empty for live quotes", () => {
    const live: PriceQuote = {
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      price_usd: 1,
      change_24h: 0,
      source: "coingecko",
    };
    expect(staleSuffix(live)).toBe("");
  });
});
