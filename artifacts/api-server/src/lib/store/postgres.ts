import type { RoomRecord, RoomStore } from "./types";

/**
 * Optional Postgres room store.
 *
 * Enabled automatically when DATABASE_URL is set (STORE=auto) — handy when you
 * outgrow a single VPS, or when the platform gives you no persistent disk
 * (Render/Railway/Heroku free tiers). Requires no migration step: the table is
 * created on boot if it is missing.
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
  }

  async insert(room: RoomRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO rooms (id, host_name, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4)`,
      [room.id, room.hostName, room.createdAt.toISOString(), room.lastSeenAt],
    );
  }

  async get(id: string): Promise<RoomRecord | undefined> {
    const { rows } = await this.pool.query(
      "SELECT id, host_name, created_at, last_seen_at FROM rooms WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;

    return {
      id: row.id,
      hostName: row.host_name,
      createdAt: new Date(row.created_at),
      lastSeenAt: Number(row.last_seen_at),
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

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}
