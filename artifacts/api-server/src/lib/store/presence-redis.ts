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

export class RedisPresence implements PresenceStore {
  readonly kind = "redis" as const;
  private client: any = null;

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    const { createClient } = await import("redis");
    this.client = createClient({ url: this.url });
    this.client.on("error", (err: unknown) => {
      // Do not throw from an event handler: log and let reconnect logic work.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 50, msg: "Redis client error", err: String(err) }));
    });
    await this.client.connect();
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
