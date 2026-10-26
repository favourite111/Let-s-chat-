/**
 * Storage contracts.
 *
 * The app has two independent kinds of state:
 *
 *  1. Rooms        — durable. Must survive a restart or a deploy.
 *                    Backed by SQLite (default) or Postgres (when DATABASE_URL
 *                    is set). See ./types.ts -> RoomStore.
 *
 *  2. Presence     — ephemeral. "Which socket ids are currently in this room."
 *                    Meaningless after a restart, so it lives in memory for a
 *                    single instance, or in Redis when you run several.
 *
 * Keeping them apart is what makes SQLite enough for a VPS: the only thing that
 * has to be durable is the room table, and that is a dozen rows.
 */

export interface RoomRecord {
  id: string;
  hostName: string | null;
  createdAt: Date;
  /** Epoch ms of the last join/leave; drives the empty-room TTL sweep. */
  lastSeenAt: number;
}

export interface RoomStore {
  readonly kind: "sqlite" | "postgres" | "memory";
  init(): Promise<void>;
  insert(room: RoomRecord): Promise<void>;
  get(id: string): Promise<RoomRecord | undefined>;
  touch(id: string, at: number): Promise<void>;
  remove(id: string): Promise<boolean>;
  count(): Promise<number>;
  /** Rooms whose lastSeenAt is older than the cutoff (candidates for removal). */
  listOlderThan(cutoff: number, limit?: number): Promise<string[]>;
  close(): Promise<void>;
}

export interface PresenceStore {
  readonly kind: "memory" | "redis";
  /** Adds a socket and returns the room's participant count after the add. */
  add(roomId: string, socketId: string): Promise<number>;
  remove(roomId: string, socketId: string): Promise<number>;
  peers(roomId: string): Promise<string[]>;
  count(roomId: string): Promise<number>;
  clear(roomId: string): Promise<void>;
  close(): Promise<void>;
}
