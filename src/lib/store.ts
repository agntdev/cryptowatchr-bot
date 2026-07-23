/**
 * Durable key-value store for domain data (profiles, watchlists, stats).
 * Redis-backed when REDIS_URL is set; in-memory otherwise (dev / tests).
 *
 * No keyspace scans — callers maintain explicit index records.
 * Workers-safe: ioredis is loaded only via dynamic import on Node paths.
 */

export interface DurableStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
}

class MemoryStore implements DurableStore {
  private data = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.data.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

class RedisStore implements DurableStore {
  constructor(
    private readonly client: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<unknown>;
      del(key: string): Promise<unknown>;
    },
    private readonly prefix = "cw:",
  ) {}

  private k(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.k(key));
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.client.set(this.k(key), JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }
}

const memory = new MemoryStore();
let backend: DurableStore = memory;
let redisInit: Promise<void> | null = null;

function ensureRedis(): void {
  if (redisInit) return;
  const url =
    typeof process !== "undefined" ? process.env.REDIS_URL : undefined;
  if (!url) return;
  redisInit = (async () => {
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ioredis: any = require("ioredis");
      const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
      const client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
      backend = new RedisStore(client);
    } catch {
      // Fall back to memory if Redis can't connect.
      backend = memory;
    }
  })();
}

async function ready(): Promise<DurableStore> {
  ensureRedis();
  if (redisInit) await redisInit;
  return backend;
}

export async function storeGet<T>(key: string): Promise<T | undefined> {
  return (await ready()).get<T>(key);
}

export async function storeSet<T>(key: string, value: T): Promise<void> {
  await (await ready()).set(key, value);
}

export async function storeDel(key: string): Promise<void> {
  await (await ready()).del(key);
}

/** Test-only: wipe the in-memory backend between specs. */
export function resetDurableStore(): void {
  memory.clear();
  if (backend === memory || !redisInit) {
    backend = memory;
  }
}

/** Inject a custom backend (tests). */
export function setDurableStore(store: DurableStore): void {
  backend = store;
  redisInit = Promise.resolve();
}
