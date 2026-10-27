import type { RoomRecord, RoomStore } from "./types";

/**
 * Optional Postgres room store.
 *
 * Enabled automatically when DATABASE_URL is set (STORE=auto) — handy when you
 * outgrow a single VPS, or when the platform gives you no persistent disk
 * (Render/Railway/Heroku free tiers). Requires no migration step: the table is
 * created on boot if it is missing, and columns added by later releases are
 * added to existing tables too.
 */
export class PostgresRoomStore implements RoomStore {
  readonly kind = "postgres" as const;
  private pool: any = null;

  /**
   * @param connectionString Postgres URL
   * @param poolFactory injection point for tests (pg-mem); defaults to `pg.Pool`
   */
  constructor(
    private readonly connectionString: string,
    private readonly poolFactory?: (config: Record<string, unknown>) => any,
  ) {}

  async init(): Promise<void> {
    const config = {
      connectionString: this.connectionString,
      max: Number(process.env["PG_POOL_SIZE"] ?? 10),
      connectionTimeoutMillis: 10_000,
    };

    if (this.poolFactory) {
      this.pool = this.poolFactory(config);
    } else {
      const { default: pg } = await import("pg");
      this.pool = new pg.Pool(config);
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id           TEXT PRIMARY KEY,
        host_name    TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at BIGINT NOT NULL
      )
    `);
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS rooms_last_seen_idx ON rooms (last_seen_at)",
    );

    // Ownership and closure columns, added after the first release. ADD COLUMN
    // IF NOT EXISTS keeps this safe to run on every boot against a live table.
    await this.pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS host_participant_id TEXT");
    await this.pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS host_secret_hash TEXT");
    await this.pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS closed_at BIGINT");
    await this.pool.query(
      "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS removed_participant_ids TEXT NOT NULL DEFAULT '[]'",
    );
  }

  async insert(room: RoomRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO rooms
         (id, host_name, created_at, last_seen_at,
          host_participant_id, host_secret_hash, closed_at, removed_participant_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        room.id,
        room.hostName,
        room.createdAt.toISOString(),
        room.lastSeenAt,
        room.hostParticipantId,
        room.hostSecretHash,
        room.closedAt,
        JSON.stringify(room.removedParticipantIds ?? []),
      ],
    );
  }

  async get(id: string): Promise<RoomRecord | undefined> {
    const { rows } = await this.pool.query(
      `SELECT id, host_name, created_at, last_seen_at,
              host_participant_id, host_secret_hash, closed_at, removed_participant_ids
       FROM rooms WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;

    return {
      id: row.id,
      hostName: row.host_name,
      createdAt: new Date(row.created_at),
      lastSeenAt: Number(row.last_seen_at),
      hostParticipantId: row.host_participant_id ?? null,
      hostSecretHash: row.host_secret_hash ?? null,
      closedAt: row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at),
      removedParticipantIds: parseRemoved(row.removed_participant_ids),
    };
  }

  async touch(id: string, at: number): Promise<void> {
    await this.pool.query("UPDATE rooms SET last_seen_at = $1 WHERE id = $2", [at, id]);
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM rooms WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query("SELECT COUNT(*)::int AS n FROM rooms");
    return rows[0]?.n ?? 0;
  }

  async listOlderThan(cutoff: number, limit = 500): Promise<string[]> {
    const { rows } = await this.pool.query(
      "SELECT id FROM rooms WHERE last_seen_at < $1 ORDER BY last_seen_at ASC LIMIT $2",
      [cutoff, limit],
    );
    return rows.map((r: { id: string }) => r.id);
  }

  async setClosed(id: string, at: number): Promise<boolean> {
    // `AND closed_at IS NULL` makes this a no-op on an already-closed room, so
    // the original closing time is preserved.
    const res = await this.pool.query(
      "UPDATE rooms SET closed_at = $1 WHERE id = $2 AND closed_at IS NULL",
      [at, id],
    );
    if ((res.rowCount ?? 0) > 0) return true;
    // Already closed — but the room exists, so report success.
    const { rows } = await this.pool.query("SELECT id FROM rooms WHERE id = $1", [id]);
    return rows.length > 0;
  }

  async addRemoved(id: string, participantId: string): Promise<boolean> {
    const room = await this.get(id);
    if (!room) return false;
    if (room.removedParticipantIds.includes(participantId)) return true;
    const next = [...room.removedParticipantIds, participantId];
    await this.pool.query("UPDATE rooms SET removed_participant_ids = $1 WHERE id = $2", [
      JSON.stringify(next),
      id,
    ]);
    return true;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}

function parseRemoved(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
