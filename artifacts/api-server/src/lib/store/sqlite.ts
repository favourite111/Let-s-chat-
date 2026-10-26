import fs from "node:fs";
import path from "node:path";
import type { RoomRecord, RoomStore } from "./types";

/**
 * SQLite room store — the default.
 *
 * Just a file on disk, so on a VPS (or any host with a real filesystem) rooms
 * survive restarts and deploys with zero infrastructure. WAL mode keeps reads
 * fast and lets the sweeper write while requests are in flight.
 *
 * Create with the path in SQLITE_PATH (default ./data/videocall.db).
 * The special value ":memory:" is honoured for tests.
 */
export class SqliteRoomStore implements RoomStore {
  readonly kind = "sqlite" as const;
  private db: any = null;
  private statements: {
    insert?: any;
    get?: any;
    touch?: any;
    remove?: any;
    count?: any;
    stale?: any;
  } = {};

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    const { default: Database } = await import("better-sqlite3");

    if (this.file !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    }

    const db = new Database(this.file);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");

    db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id           TEXT PRIMARY KEY,
        host_name    TEXT,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rooms_last_seen_idx ON rooms (last_seen_at);
    `);

    this.db = db;
    this.statements = {
      insert: db.prepare(
        "INSERT INTO rooms (id, host_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      ),
      get: db.prepare(
        "SELECT id, host_name, created_at, last_seen_at FROM rooms WHERE id = ?",
      ),
      touch: db.prepare("UPDATE rooms SET last_seen_at = ? WHERE id = ?"),
      remove: db.prepare("DELETE FROM rooms WHERE id = ?"),
      count: db.prepare("SELECT COUNT(*) AS n FROM rooms"),
      stale: db.prepare(
        "SELECT id FROM rooms WHERE last_seen_at < ? ORDER BY last_seen_at ASC LIMIT ?",
      ),
    };
  }

  async insert(room: RoomRecord): Promise<void> {
    this.statements.insert!.run(
      room.id,
      room.hostName,
      room.createdAt.getTime(),
      room.lastSeenAt,
    );
  }

  async get(id: string): Promise<RoomRecord | undefined> {
    const row = this.statements.get!.get(id) as
      | { id: string; host_name: string | null; created_at: number; last_seen_at: number }
      | undefined;
    if (!row) return undefined;

    return {
      id: row.id,
      hostName: row.host_name,
      createdAt: new Date(row.created_at),
      lastSeenAt: row.last_seen_at,
    };
  }

  async touch(id: string, at: number): Promise<void> {
    this.statements.touch!.run(at, id);
  }

  async remove(id: string): Promise<boolean> {
    return this.statements.remove!.run(id).changes > 0;
  }

  async count(): Promise<number> {
    return (this.statements.count!.get() as { n: number }).n;
  }

  async listOlderThan(cutoff: number, limit = 500): Promise<string[]> {
    return (this.statements.stale!.all(cutoff, limit) as { id: string }[]).map((r) => r.id);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
