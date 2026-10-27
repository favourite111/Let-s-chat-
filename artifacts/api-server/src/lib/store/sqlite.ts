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
    closeRoom?: any;
    addRemoved?: any;
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

    // Ownership and closure columns arrived after the first release. Databases
    // created by that release still exist (including the one on Render), so add
    // whatever is missing rather than assuming a fresh table.
    this.addColumnIfMissing(db, "rooms", "host_participant_id", "TEXT");
    this.addColumnIfMissing(db, "rooms", "host_secret_hash", "TEXT");
    this.addColumnIfMissing(db, "rooms", "closed_at", "INTEGER");
    this.addColumnIfMissing(db, "rooms", "removed_participant_ids", "TEXT NOT NULL DEFAULT '[]'");

    this.db = db;
    this.statements = {
      insert: db.prepare(
        `INSERT INTO rooms
           (id, host_name, created_at, last_seen_at,
            host_participant_id, host_secret_hash, closed_at, removed_participant_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      get: db.prepare(
        `SELECT id, host_name, created_at, last_seen_at,
                host_participant_id, host_secret_hash, closed_at, removed_participant_ids
         FROM rooms WHERE id = ?`,
      ),
      touch: db.prepare("UPDATE rooms SET last_seen_at = ? WHERE id = ?"),
      remove: db.prepare("DELETE FROM rooms WHERE id = ?"),
      count: db.prepare("SELECT COUNT(*) AS n FROM rooms"),
      stale: db.prepare(
        "SELECT id FROM rooms WHERE last_seen_at < ? ORDER BY last_seen_at ASC LIMIT ?",
      ),
      closeRoom: db.prepare("UPDATE rooms SET closed_at = ? WHERE id = ? AND closed_at IS NULL"),
      addRemoved: db.prepare("UPDATE rooms SET removed_participant_ids = ? WHERE id = ?"),
    };
  }

  /** ALTER TABLE ... ADD COLUMN is not idempotent in SQLite; check first. */
  private addColumnIfMissing(db: any, table: string, column: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async insert(room: RoomRecord): Promise<void> {
    this.statements.insert!.run(
      room.id,
      room.hostName,
      room.createdAt.getTime(),
      room.lastSeenAt,
      room.hostParticipantId,
      room.hostSecretHash,
      room.closedAt,
      JSON.stringify(room.removedParticipantIds ?? []),
    );
  }

  async get(id: string): Promise<RoomRecord | undefined> {
    const row = this.statements.get!.get(id) as
      | {
          id: string;
          host_name: string | null;
          created_at: number;
          last_seen_at: number;
          host_participant_id: string | null;
          host_secret_hash: string | null;
          closed_at: number | null;
          removed_participant_ids: string | null;
        }
      | undefined;
    if (!row) return undefined;

    return {
      id: row.id,
      hostName: row.host_name,
      createdAt: new Date(row.created_at),
      lastSeenAt: row.last_seen_at,
      hostParticipantId: row.host_participant_id ?? null,
      hostSecretHash: row.host_secret_hash ?? null,
      closedAt: row.closed_at ?? null,
      removedParticipantIds: parseRemoved(row.removed_participant_ids),
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

  async setClosed(id: string, at: number): Promise<boolean> {
    return this.statements.closeRoom!.run(at, id).changes > 0;
  }

  async addRemoved(id: string, participantId: string): Promise<boolean> {
    const room = await this.get(id);
    if (!room) return false;
    if (room.removedParticipantIds.includes(participantId)) return true;
    const next = [...room.removedParticipantIds, participantId];
    this.statements.addRemoved!.run(JSON.stringify(next), id);
    return true;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

function parseRemoved(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
