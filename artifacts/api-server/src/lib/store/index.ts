import { logger } from "../logger";
import { MemoryPresence } from "./presence-memory";
import { RedisPresence } from "./presence-redis";
import { MemoryRoomStore } from "./memory";
import { SqliteRoomStore } from "./sqlite";
import { PostgresRoomStore } from "./postgres";
import type { PresenceStore, RoomStore } from "./types";

export type { PresenceStore, RoomRecord, RoomStore } from "./types";
export { MemoryRoomStore, MemoryPresence, SqliteRoomStore, PostgresRoomStore, RedisPresence };

export const DEFAULT_SQLITE_PATH = "./data/videocall.db";

/**
 * Choose a room store.
 *
 *   STORE=auto (default) → Postgres if DATABASE_URL is set, else SQLite
 *   STORE=sqlite         → force SQLite (path from SQLITE_PATH)
 *   STORE=postgres       → force Postgres (requires DATABASE_URL)
 *   STORE=memory         → volatile, for tests
 *
 * If the preferred backend cannot initialise (missing driver, unwritable disk,
 * database down) we log loudly and fall back to the next best option rather
 * than refusing to boot — a working app with a warning beats a dead one.
 */
export async function createRoomStore(): Promise<RoomStore> {
  const preference = (process.env["STORE"] ?? "auto").toLowerCase();
  const databaseUrl = process.env["DATABASE_URL"];
  const sqlitePath = process.env["SQLITE_PATH"] ?? DEFAULT_SQLITE_PATH;

  const tryPostgres = async (): Promise<RoomStore | null> => {
    if (!databaseUrl) return null;
    const store = new PostgresRoomStore(databaseUrl);
    await store.init();
    return store;
  };

  /**
   * An explicitly configured SQLITE_PATH is a promise that rooms are durable.
   * If it cannot be opened we stop the boot with a clear error instead of
   * silently degrading to memory and losing rooms on the next restart.
   * The default path is allowed to fall back so `pnpm dev` works anywhere.
   */
  const sqlitePathIsExplicit = Boolean(process.env["SQLITE_PATH"]);

  const trySqlite = async (): Promise<RoomStore | null> => {
    try {
      const store = new SqliteRoomStore(sqlitePath);
      await store.init();
      return store;
    } catch (err) {
      if (sqlitePathIsExplicit) {
        throw new Error(
          `Cannot open the SQLite database at "${sqlitePath}". ` +
            `Check that the directory exists and is writable by the app user. ` +
            `Original error: ${(err as Error).message}`,
        );
      }
      logger.warn(
        { err, sqlitePath },
        "SQLite unavailable at the default path, using in-memory rooms (rooms will NOT survive a restart). Set SQLITE_PATH to a writable location to persist them.",
      );
      return null;
    }
  };

  const finish = (store: RoomStore): RoomStore => {
    logger.info({ store: store.kind }, "Room store ready");
    return store;
  };

  if (preference === "memory") {
    return finish(new MemoryRoomStore());
  }

  if (preference === "sqlite") {
    return finish((await trySqlite()) ?? new MemoryRoomStore());
  }

  if (preference === "postgres") {
    if (!databaseUrl) {
      throw new Error("STORE=postgres requires DATABASE_URL");
    }
    const store = await tryPostgres();
    if (!store) throw new Error("Postgres store could not be created");
    return finish(store);
  }

  // auto
  if (databaseUrl) {
    try {
      const store = await tryPostgres();
      if (store) return finish(store);
    } catch (err) {
      logger.error({ err }, "Postgres unavailable, falling back to SQLite");
    }
  }

  return finish((await trySqlite()) ?? new MemoryRoomStore());
}

/**
 * Presence store: Redis when REDIS_URL is set (needed for >1 instance),
 * otherwise in-process memory, which is correct for a single VPS.
 */
export async function createPresenceStore(): Promise<PresenceStore> {
  const redisUrl = process.env["REDIS_URL"];

  if (redisUrl && (process.env["PRESENCE"] ?? "auto") !== "memory") {
    try {
      const presence = new RedisPresence(redisUrl);
      await presence.init();
      logger.info({ presence: presence.kind }, "Presence store ready");
      return presence;
    } catch (err) {
      logger.error({ err }, "Redis unavailable, falling back to in-memory presence");
    }
  }

  const presence = new MemoryPresence();
  logger.info({ presence: presence.kind }, "Presence store ready");
  return presence;
}
