/**
 * Storage contracts.
 *
 * The app has two independent kinds of state:
 *
 *  1. Rooms        — durable. Must survive a restart or a deploy.
 *                    Backed by SQLite (default) or Postgres (when DATABASE_URL
 *                    is set). See ./types.ts -> RoomStore.
 *
 *  2. Participants — ephemeral. Who is currently in a room, keyed by a stable
 *                    participant id rather than a socket id.
 *                    In memory for a single instance, or in Redis when you run
 *                    several.
 *
 * Keeping them apart is what makes SQLite enough for a VPS: the only thing that
 * has to be durable is the room table, and that is a dozen rows.
 *
 * Why presence is keyed by participantId and not socketId: a socket id changes
 * on every reconnect, so keying by it makes a page reload look like a brand new
 * person — which is exactly how a room filled up with ghosts of its own
 * occupants. A participantId is minted once per browser and presented again on
 * every join, so a reload reclaims the same seat instead of taking a second one.
 */

export interface RoomRecord {
  id: string;
  hostName: string | null;
  createdAt: Date;
  /** Epoch ms of the last join/leave; drives the empty-room TTL sweep. */
  lastSeenAt: number;
  /**
   * Stable id of the participant who created the room.
   *
   * Ownership is fixed at creation and never reassigned. If the host never
   * comes back, the room simply expires — it is never handed to anyone else.
   */
  hostParticipantId: string | null;
  /** SHA-256 of the host's secret. The secret itself is never stored. */
  hostSecretHash: string | null;
  /** Epoch ms when the host ended the call. A closed room accepts no joins. */
  closedAt: number | null;
  /** Participant ids the host removed; they may not rejoin this room. */
  removedParticipantIds: string[];
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
  /**
   * Mark a room closed (the host ended the call). Returns false if it does not
   * exist. Named setClosed because `close()` already means "shut the store".
   */
  setClosed(id: string, at: number): Promise<boolean>;
  /** Add a participant id to the room's removal list. */
  addRemoved(id: string, participantId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface ParticipantRecord {
  /** Stable across reconnects; minted by the client and presented on every join. */
  participantId: string;
  /** The socket currently carrying this participant, or null while disconnected. */
  socketId: string | null;
  role: "host" | "guest";
  displayName: string | null;
  joinedAt: number;
  connectedAt: number | null;
  /** Set when the socket goes away; cleared when the participant returns. */
  disconnectedAt: number | null;
}

export interface PresenceStore {
  readonly kind: "memory" | "redis";
  /** Insert or replace a participant record for a room. */
  upsert(roomId: string, participant: ParticipantRecord): Promise<void>;
  get(roomId: string, participantId: string): Promise<ParticipantRecord | undefined>;
  remove(roomId: string, participantId: string): Promise<void>;
  /** Mark a participant's socket gone but keep their seat during the grace period. */
  /**
   * Mark a participant as disconnected.
   *
   * `socketId` is an optional compare-and-set guard: pass the socket that is
   * going away and the write only applies if the participant is still on that
   * socket. Without it, a socket that timed out *after* the participant had
   * already reconnected elsewhere would mark the live session dead — the
   * stale-socket bug in a different costume.
   *
   * Returns true when the record was actually changed.
   */
  markDisconnected(
    roomId: string,
    participantId: string,
    at: number,
    socketId?: string | null,
  ): Promise<boolean>;
  list(roomId: string): Promise<ParticipantRecord[]>;
  /** Connected participants only — what room capacity is measured against. */
  countConnected(roomId: string): Promise<number>;
  clear(roomId: string): Promise<void>;
  close(): Promise<void>;
}
