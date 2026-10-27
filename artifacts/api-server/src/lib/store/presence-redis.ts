import type { PresenceStore } from "./types";

/**
 * Redis-backed presence, for running more than one instance.
 *
 * Only presence lives in Redis — the durable room table stays in Postgres (or
 * SQLite). A socket's presence is short-lived by nature, so each room set gets
 * a TTL that is refreshed on every join/leave: if an instance is killed
 * without cleaning up, its stale entries disappear on their own.
 *
 * Multi-instance also requires the Socket.IO Redis adapter (wired in
 * src/index.ts) plus sticky sessions at the load balancer.
 */
const KEY_PREFIX = "videocall:peers:";
const KEY_TTL_SECONDS = 6 * 60 * 60;
const CONNECT_TIMEOUT_MS = Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 8_000);

export class RedisPresence implements PresenceStore {
  readonly kind = "redis" as const;
  private client: any = null;

  /**
   * @param url           Redis URL
   * @param clientFactory injection point for tests; defaults to redis.createClient
   */
  constructor(
    private readonly url: string,
    private readonly clientFactory?: (options: { url: string }) => any,
  ) {}

  async init(): Promise<void> {
    if (this.clientFactory) {
      this.client = this.clientFactory({ url: this.url });
      await this.client.connect();
      return;
    }

    const { createClient } = await import("redis");
    const client = createClient({
      url: this.url,
      // node-redis otherwise retries a bad host forever, which turns a
      // misconfigured REDIS_URL into a hung boot instead of a clear error.
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    });

    client.on("error", (err: unknown) => {
      // Never throw from an event handler; log and let the caller decide.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 50, msg: "Redis client error", err: String(err) }));
    });

    // Fail fast: reject on the first error or when the timeout elapses, rather
    // than waiting for an infinite reconnect loop.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Redis connection timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      timer.unref?.();

      client.once("error", (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      client
        .connect()
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    // Connected: restore normal retry behaviour for the rest of the run.
    this.client = client;
  }

  private key(roomId: string): string {
    return `${KEY_PREFIX}${roomId}`;
  }

  async add(roomId: string, socketId: string): Promise<number> {
    const key = this.key(roomId);
    await this.client.sAdd(key, socketId);
    await this.client.expire(key, KEY_TTL_SECONDS);
    return this.client.sCard(key);
  }

  async remove(roomId: string, socketId: string): Promise<number> {
    const key = this.key(roomId);
    await this.client.sRem(key, socketId);
    const size = await this.client.sCard(key);
    if (size === 0) await this.client.del(key);
    return size;
  }

  async peers(roomId: string): Promise<string[]> {
    return this.client.sMembers(this.key(roomId));
  }

  async count(roomId: string): Promise<number> {
    return this.client.sCard(this.key(roomId));
  }

  async clear(roomId: string): Promise<void> {
    await this.client.del(this.key(roomId));
  }

  async close(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
    this.client = null;
  }
}
