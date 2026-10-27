import { createHash, randomInt, timingSafeEqual } from "crypto";
import { logger } from "./logger";
import {
  createPresenceStore,
  createRoomStore,
  type ParticipantRecord,
  type PresenceStore,
  type RoomRecord,
  type RoomStore,
} from "./store";

/**
 * Room service.
 *
 * The single place that combines the durable room table (SQLite by default,
 * Postgres when configured) with ephemeral presence (memory, or Redis when
 * running several instances). Routes and the Socket.IO layer only ever talk to
 * this module, so `participantCount` and "does this room exist" can never drift
 * apart.
 *
 * Two rules are enforced here and nowhere else:
 *
 *  - **Capacity is measured in connected participants.** A participant whose
 *    socket died keeps their seat (and their identity) for a grace period, but
 *    does not count against capacity, so a reload or a dropped connection can
 *    never fill a room with ghosts of the people already in it.
 *
 *  - **Ownership is fixed at creation.** The creator's participant id and a
 *    hash of a secret only their browser holds are stored on the room, and the
 *    host role is granted only when both match. Ownership is never transferred,
 *    automatically or otherwise: if the host never returns, the room expires
 *    under the normal rules rather than passing to someone else.
 */

/** Unambiguous alphabet (Crockford base32, no I/L/O/U). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 12 chars of 32 symbols = 60 bits of entropy. */
export const ROOM_ID_LENGTH = 12;

const DEFAULT_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 2 * 60 * 60 * 1000);
const SWEEP_INTERVAL_MS = Number(process.env.ROOM_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000);
/**
 * How long a disconnected participant keeps their seat so a reconnect can
 * reclaim it. Long enough to survive a tunnel or a page reload, short enough
 * that an abandoned session is cleaned up promptly. Presence entries outside
 * this window are purged on the next join or sweep.
 */
const GRACE_MS = Number(process.env.PARTICIPANT_GRACE_MS ?? 45_000);
const MAX_HOST_NAME = 64;
const MAX_PARTICIPANT_ID = 128;
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 20_000);
/**
 * Seats in a room. Still 2 — group calling is a later phase; nothing here
 * assumes a pair beyond this number.
 */
const MAX_PARTICIPANTS = Number(process.env.MAX_PARTICIPANTS ?? 2);

export interface PublicRoom {
  id: string;
  hostName: string | null;
  participantCount: number;
  createdAt: string;
  /** The host ended this call; nobody can join it again. */
  closed: boolean;
  /**
   * Whether the host's own seat is occupied right now.
   *
   * Used by the client to tell "the host is already in another window" from
   * "the host is gone": only in the second case may a new tab that holds the
   * host secret present the host identity and keep the room controllable.
   */
  hostConnected: boolean;
  /** The person joining is the host. Only ever true for the host's own view. */
  isHost?: boolean;
}

export interface PublicParticipant {
  participantId: string;
  role: "host" | "guest";
  displayName: string | null;
  connected: boolean;
}

export interface RoomService {
  store: RoomStore;
  presence: PresenceStore;
}

let service: RoomService | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

export function generateRoomId(): string {
  let id = "";
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

export function normaliseHostName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_HOST_NAME);
  return trimmed.length > 0 ? trimmed : null;
}

/** A participant id is client-minted; validate the shape, not the value. */
export function normaliseParticipantId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > MAX_PARTICIPANT_ID) return null;
  return /^[A-Za-z0-9:_-]+$/.test(trimmed) ? trimmed : null;
}

function requireService(): RoomService {
  if (!service) throw new Error("Room service not initialised — call initRooms() first");
  return service;
}

/** Boot the stores and start the TTL sweeper. Idempotent. */
export async function initRooms(overrides?: Partial<RoomService>): Promise<RoomService> {
  if (service) return service;

  const store = overrides?.store ?? (await createRoomStore());
  const presence = overrides?.presence ?? (await createPresenceStore());
  service = { store, presence };

  sweepTimer = setInterval(() => {
    void sweepExpired().catch((err) => logger.error({ err }, "Room sweep failed"));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  return service;
}

export async function closeRooms(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  await service?.presence.close();
  await service?.store.close();
  service = null;
}

// ─── host secret ────────────────────────────────────────────────────────────

export function hashHostSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Is this participant the owner, and did they prove it?
 *
 * Both halves are required. A participant id is not a secret — it circulates in
 * signalling so peers can address each other — so knowing the host's id must
 * not be enough to act as the host.
 */
export function verifyHost(room: RoomRecord, participantId: string, secret: unknown): boolean {
  if (!room.hostParticipantId || !room.hostSecretHash) return false;
  if (room.hostParticipantId !== participantId) return false;
  if (typeof secret !== "string" || secret.length === 0) return false;
  return hashesMatch(room.hostSecretHash, hashHostSecret(secret));
}

// ─── rooms ──────────────────────────────────────────────────────────────────

export interface CreateRoomInput {
  hostName?: unknown;
  hostParticipantId?: unknown;
  /** Plain secret from the host's browser; only its hash is stored. */
  hostSecret?: unknown;
}

export async function createRoom(input: CreateRoomInput): Promise<RoomRecord> {
  const { store } = requireService();

  if ((await store.count()) >= MAX_ROOMS) {
    await sweepExpired();
    if ((await store.count()) >= MAX_ROOMS) throw new Error("Room capacity reached");
  }

  let id = generateRoomId();
  while (await store.get(id)) id = generateRoomId();

  const hostParticipantId = normaliseParticipantId(input.hostParticipantId);
  const secret = typeof input.hostSecret === "string" ? input.hostSecret : null;

  const now = Date.now();
  const room: RoomRecord = {
    id,
    hostName: normaliseHostName(input.hostName),
    createdAt: new Date(now),
    lastSeenAt: now,
    // Ownership is only claimed when the creator supplied both halves. A room
    // created by an older client simply has no owner, and nobody can become one
    // later — there is no path that assigns ownership after creation.
    hostParticipantId: hostParticipantId && secret ? hostParticipantId : null,
    hostSecretHash: hostParticipantId && secret ? hashHostSecret(secret) : null,
    closedAt: null,
    removedParticipantIds: [],
  };

  await store.insert(room);
  return room;
}

export async function getRoom(roomId: string): Promise<RoomRecord | undefined> {
  return requireService().store.get(roomId);
}

export async function toPublicRoom(room: RoomRecord): Promise<PublicRoom> {
  const { presence } = requireService();

  const hostSeat =
    room.hostParticipantId !== null
      ? await presence.get(room.id, room.hostParticipantId)
      : undefined;

  return {
    id: room.id,
    hostName: room.hostName,
    participantCount: await presence.countConnected(room.id),
    createdAt: room.createdAt.toISOString(),
    closed: room.closedAt !== null,
    hostConnected: Boolean(hostSeat && hostSeat.socketId !== null),
  };
}

export function toPublicParticipants(participants: ParticipantRecord[]): PublicParticipant[] {
  return participants.map((p) => ({
    participantId: p.participantId,
    role: p.role,
    displayName: p.displayName,
    connected: Boolean(p.socketId),
  }));
}

// ─── joining ────────────────────────────────────────────────────────────────

/**
 * Serialise joins per room.
 *
 * Two joins for the *same* participant can overlap when a socket is dying while
 * its replacement connects (the reload case). Both read the same presence
 * record, and without ordering the older join could write its dead socket id
 * back over the new one — the seat would then look occupied by a socket that no
 * longer exists. Joins are cheap, so a per-room queue costs nothing and makes
 * the outcome depend on arrival order instead of on timing luck.
 */
const joinQueues = new Map<string, Promise<unknown>>();

async function withJoinLock<T>(roomId: string, work: () => Promise<T>): Promise<T> {
  const previous = joinQueues.get(roomId) ?? Promise.resolve();
  const run = previous.then(work, work);
  // Keep the chain alive even if this join rejects, then drop it once idle.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  joinQueues.set(roomId, settled);
  try {
    return await run;
  } finally {
    if (joinQueues.get(roomId) === settled) joinQueues.delete(roomId);
  }
}

/** Socket ids are opaque, but an empty one means "connected to nothing". */
function isNonEmptySocketId(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 64;
}

export type JoinFailure =
  | "not-found"
  | "closed"
  | "removed"
  | "full"
  | "host-auth-failed"
  | "invalid-participant";

export interface JoinInput {
  participantId: string;
  socketId: string;
  hostSecret?: unknown;
  displayName?: unknown;
}

export type JoinResult =
  | {
      ok: true;
      room: RoomRecord;
      participant: ParticipantRecord;
      isHost: boolean;
      /** True when this join reclaimed an existing seat instead of taking one. */
      reclaimed: boolean;
      /**
       * The socket that held this seat before the reclaim, if any. The caller
       * uses it to tell a superseded tab that it is no longer in the call —
       * which is what happens when the same identity is opened twice.
       */
      previousSocketId: string | null;
      others: ParticipantRecord[];
    }
  | { ok: false; reason: JoinFailure };

/**
 * Drop presence entries that have been disconnected for longer than the grace
 * period. Called before capacity can matter, so an abandoned session never
 * counts — belt and braces alongside capacity using connected-only counts.
 */
export async function purgeStaleParticipants(roomId: string, graceMs = GRACE_MS): Promise<number> {
  const { presence } = requireService();
  const now = Date.now();
  let purged = 0;

  for (const participant of await presence.list(roomId)) {
    if (participant.socketId !== null) continue;
    const since = participant.disconnectedAt ?? participant.joinedAt;
    if (now - since > graceMs) {
      await presence.remove(roomId, participant.participantId);
      purged += 1;
    }
  }

  return purged;
}

export async function joinRoom(roomId: string, input: JoinInput): Promise<JoinResult> {
  // Everything below reads and then writes the same presence record; the queue
  // keeps two joins for one room from interleaving.
  return withJoinLock(roomId, () => joinRoomLocked(roomId, input));
}

async function joinRoomLocked(roomId: string, input: JoinInput): Promise<JoinResult> {
  const { store, presence } = requireService();

  // Validate here as well as in the socket layer: this is the function that
  // writes presence, so it must not depend on its caller having checked.
  const participantId = normaliseParticipantId(input.participantId);
  if (!participantId || !isNonEmptySocketId(input.socketId)) {
    return { ok: false, reason: "invalid-participant" };
  }

  const room = await store.get(roomId);
  if (!room) return { ok: false, reason: "not-found" };

  // A closed room rejects everyone, including its host. "End call" is final.
  if (room.closedAt !== null) return { ok: false, reason: "closed" };

  if (room.removedParticipantIds.includes(participantId)) {
    return { ok: false, reason: "removed" };
  }

  await purgeStaleParticipants(roomId);

  const now = Date.now();
  const existing = await presence.get(roomId, participantId);

  // Ownership is proven, never inferred from having got here first.
  const claimsOwnership = room.hostParticipantId === participantId;
  if (claimsOwnership && !verifyHost(room, participantId, input.hostSecret)) {
    // Someone knows the host's id but not the secret. Refuse rather than let
    // them occupy the host's seat or quietly demote them to a guest: either
    // would take the seat the real host needs.
    logger.warn({ roomId, participantId }, "Join rejected: host secret invalid");
    return { ok: false, reason: "host-auth-failed" };
  }

  const isHost = claimsOwnership;
  const role: ParticipantRecord["role"] = isHost ? "host" : "guest";
  const displayName = normaliseHostName(input.displayName) ?? (isHost ? room.hostName : null);

  if (existing) {
    // Reclaim: same person, new socket. Never consumes a second seat.
    //
    // The exception is a seat that had gone stale while somebody else took the
    // free slot in the meantime: coming back would make three people in a
    // two-person room. Refuse with "full" (the client retries) rather than
    // silently overfilling.
    if (existing.socketId === null && (await presence.countConnected(roomId)) >= MAX_PARTICIPANTS) {
      return { ok: false, reason: "full" };
    }

    const participant: ParticipantRecord = {
      ...existing,
      socketId: input.socketId,
      role,
      displayName: displayName ?? existing.displayName,
      connectedAt: now,
      disconnectedAt: null,
    };
    await presence.upsert(roomId, participant);
    await store.touch(roomId, now);
    return {
      ok: true,
      room,
      participant,
      isHost,
      reclaimed: true,
      previousSocketId: existing.socketId,
      others: await otherParticipants(roomId, participantId),
    };
  }

  if ((await presence.countConnected(roomId)) >= MAX_PARTICIPANTS) {
    return { ok: false, reason: "full" };
  }

  const participant: ParticipantRecord = {
    participantId,
    socketId: input.socketId,
    role,
    displayName,
    joinedAt: now,
    connectedAt: now,
    disconnectedAt: null,
  };

  // Insert, then verify: two simultaneous joins can both pass the check above,
  // so whoever ends up over capacity removes themselves. The loser is chosen
  // deterministically (latest joinedAt, then participantId) so that they cannot
  // both conclude they are the loser and leave the room empty.
  await presence.upsert(roomId, participant);

  const connected = (await presence.list(roomId)).filter((p) => p.socketId !== null);
  if (connected.length > MAX_PARTICIPANTS) {
    const newest = connected.slice().sort((a, b) => {
      if (b.joinedAt !== a.joinedAt) return b.joinedAt - a.joinedAt;
      return b.participantId.localeCompare(a.participantId);
    })[0];

    if (newest.participantId === participantId) {
      await presence.remove(roomId, participantId);
      logger.info({ roomId, participantId }, "Join lost the capacity race");
      return { ok: false, reason: "full" };
    }
  }

  await store.touch(roomId, now);
  return {
    ok: true,
    room,
    participant,
    isHost,
    reclaimed: false,
    previousSocketId: null,
    others: await otherParticipants(roomId, participantId),
  };
}

async function otherParticipants(roomId: string, exceptId: string): Promise<ParticipantRecord[]> {
  return (await requireService().presence.list(roomId)).filter(
    (p) => p.participantId !== exceptId,
  );
}

/**
 * A socket went away. The participant keeps their seat for the grace period so
 * a reconnect can reclaim it, but stops counting against capacity immediately.
 */
export async function leaveRoom(
  roomId: string,
  participantId: string,
  socketId?: string | null,
): Promise<boolean> {
  const { store, presence } = requireService();
  const changed = await presence.markDisconnected(roomId, participantId, Date.now(), socketId);
  if (changed) await store.touch(roomId, Date.now());
  return changed;
}

/** Explicit departure: the participant is gone for good, so free the seat now. */
export async function abandonRoom(roomId: string, participantId: string): Promise<void> {
  const { store, presence } = requireService();
  await presence.remove(roomId, participantId);
  await store.touch(roomId, Date.now());
}

export async function roomParticipants(roomId: string): Promise<ParticipantRecord[]> {
  return requireService().presence.list(roomId);
}

/**
 * participantId → socketId for everyone currently connected. Used by the
 * signalling layer to address peers by identity rather than by a socket id that
 * changes on every reconnect.
 */
export async function roomSockets(roomId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const participant of await requireService().presence.list(roomId)) {
    if (participant.socketId) map.set(participant.participantId, participant.socketId);
  }
  return map;
}

// ─── host actions ───────────────────────────────────────────────────────────

export type HostActionFailure = "not-found" | "not-host" | "already-closed" | "target-not-found";

/**
 * End the call for everyone and close the room permanently.
 *
 * Every participant is evicted and no join succeeds afterwards. Deliberately
 * there is no "reopen": a closed room is only ever removed.
 */
export async function closeRoomByHost(
  roomId: string,
  actorParticipantId: string,
  hostSecret: unknown,
): Promise<{ ok: true } | { ok: false; reason: HostActionFailure }> {
  const { store, presence } = requireService();

  const room = await store.get(roomId);
  if (!room) return { ok: false, reason: "not-found" };
  if (!verifyHost(room, actorParticipantId, hostSecret)) return { ok: false, reason: "not-host" };

  if (room.closedAt !== null) return { ok: false, reason: "already-closed" };

  await store.setClosed(roomId, Date.now());
  await presence.clear(roomId);
  logger.info({ roomId, by: actorParticipantId }, "Room closed by host");
  return { ok: true };
}

/**
 * Remove a participant and bar them from the room.
 *
 * The removal list lives on the room, so it survives the removed person
 * reconnecting, reloading, or waiting for their grace period to lapse.
 */
export async function removeParticipantByHost(
  roomId: string,
  actorParticipantId: string,
  hostSecret: unknown,
  targetParticipantId: string,
): Promise<{ ok: true; socketId: string | null } | { ok: false; reason: HostActionFailure }> {
  const { store, presence } = requireService();

  const room = await store.get(roomId);
  if (!room) return { ok: false, reason: "not-found" };
  if (!verifyHost(room, actorParticipantId, hostSecret)) return { ok: false, reason: "not-host" };
  if (targetParticipantId === actorParticipantId) return { ok: false, reason: "target-not-found" };

  const target = await presence.get(roomId, targetParticipantId);
  if (!target) return { ok: false, reason: "target-not-found" };

  const socketId = target.socketId;
  await store.addRemoved(roomId, targetParticipantId);
  await presence.remove(roomId, targetParticipantId);
  logger.info({ roomId, by: actorParticipantId, removed: targetParticipantId }, "Participant removed");
  return { ok: true, socketId };
}

// ─── housekeeping ───────────────────────────────────────────────────────────

export async function deleteRoom(roomId: string): Promise<boolean> {
  const { store, presence } = requireService();
  await presence.clear(roomId);
  return store.remove(roomId);
}

export async function roomCount(): Promise<number> {
  return requireService().store.count();
}

/**
 * The room backend actually in use: "postgres", "sqlite" or "memory".
 *
 * Exposed through /api/healthz because "the deploy is up" says nothing about
 * where rooms are being written — on a host with an ephemeral disk that
 * difference is the whole ballgame.
 */
export function roomStoreKind(): string | null {
  try {
    return requireService().store.kind;
  } catch {
    return null;
  }
}

/** Delete rooms that are both empty and idle past the TTL. */
export async function sweepExpired(ttlMs = DEFAULT_TTL_MS): Promise<number> {
  const { store, presence } = requireService();
  const stale = await store.listOlderThan(Date.now() - ttlMs);
  let removed = 0;

  for (const id of stale) {
    await purgeStaleParticipants(id);
    if ((await presence.countConnected(id)) === 0) {
      if (await store.remove(id)) removed += 1;
    }
  }

  if (removed > 0) logger.info({ removed }, "Expired rooms swept");
  return removed;
}

export function roomLimits() {
  return {
    maxRooms: MAX_ROOMS,
    maxParticipants: MAX_PARTICIPANTS,
    ttlMs: DEFAULT_TTL_MS,
    graceMs: GRACE_MS,
  };
}
