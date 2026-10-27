import type { ParticipantRecord, PresenceStore } from "./types";

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
const KEY_PREFIX = "videocall:participants:";
const KEY_TTL_SECONDS = 6 * 60 * 60;
const CONNECT_TIMEOUT_MS = Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 8_000);

/**
 * Participants live in a Redis hash per room, field = participantId, value =
 * the record as JSON. A hash rather than a set because a participant now
 * carries a socket, a role and timestamps — and because the record has to
 * survive a disconnect so a reconnect can reclaim the same seat.
 */
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

  private parse(raw: unknown): ParticipantRecord | null {
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as ParticipantRecord;
    } catch {
      return null;
    }
  }

  async upsert(roomId: string, participant: ParticipantRecord): Promise<void> {
    const key = this.key(roomId);
    await this.client.hSet(key, participant.participantId, JSON.stringify(participant));
    await this.client.expire(key, KEY_TTL_SECONDS);
  }

  async get(roomId: string, participantId: string): Promise<ParticipantRecord | undefined> {
    return this.parse(await this.client.hGet(this.key(roomId), participantId)) ?? undefined;
  }

  async remove(roomId: string, participantId: string): Promise<void> {
    const key = this.key(roomId);
    await this.client.hDel(key, participantId);
    if ((await this.client.hLen(key)) === 0) await this.client.del(key);
  }

  async markDisconnected(
    roomId: string,
    participantId: string,
    at: number,
    socketId?: string | null,
  ): Promise<boolean> {
    const key = this.key(roomId);
    const record = await this.get(roomId, participantId);
    if (!record) return false;

    // Compare-and-set: a socket that has since been superseded by a reconnect
    // must not clear the live session.
    if (socketId !== undefined && record.socketId !== null && record.socketId !== socketId) {
      return false;
    }

    record.socketId = null;
    record.disconnectedAt = at;
    await this.client.hSet(key, participantId, JSON.stringify(record));
    await this.client.expire(key, KEY_TTL_SECONDS);
    return true;
  }

  async list(roomId: string): Promise<ParticipantRecord[]> {
    const flat: unknown = await this.client.hGetAll(this.key(roomId));
    if (!flat || typeof flat !== "object") return [];
    return Object.values(flat as Record<string, unknown>)
      .map((v) => this.parse(v))
      .filter((p): p is ParticipantRecord => p !== null);
  }

  async countConnected(roomId: string): Promise<number> {
    return (await this.list(roomId)).filter((p) => Boolean(p.socketId)).length;
  }

  async clear(roomId: string): Promise<void> {
    await this.client.del(this.key(roomId));
  }

  async close(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
    this.client = null;
  }
}
