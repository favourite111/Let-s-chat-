import { randomInt } from "crypto";
import { logger } from "./logger";
import {
  createPresenceStore,
  createRoomStore,
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
 * apart again.
 */

/** Unambiguous alphabet (Crockford base32, no I/L/O/U). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 12 chars of 32 symbols = 60 bits of entropy. */
export const ROOM_ID_LENGTH = 12;

const DEFAULT_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 2 * 60 * 60 * 1000);
const SWEEP_INTERVAL_MS = Number(process.env.ROOM_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000);
const MAX_HOST_NAME = 64;
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 20_000);
const MAX_PARTICIPANTS = Number(process.env.MAX_PARTICIPANTS ?? 2);

export interface PublicRoom {
  id: string;
  hostName: string | null;
  participantCount: number;
  createdAt: string;
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

function requireService(): RoomService {
  if (!service) throw new Error("Room service not initialised — call initRooms() first");
  return service;
}

/** Boot the stores and start the TTL sweeper. Idempotent. */
export async function initRooms(): Promise<RoomService> {
  if (service) return service;

  const store = await createRoomStore();
  const presence = await createPresenceStore();
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

export async function createRoom(hostName: unknown): Promise<RoomRecord> {
  const { store } = requireService();

  if ((await store.count()) >= MAX_ROOMS) {
    await sweepExpired();
    if ((await store.count()) >= MAX_ROOMS) throw new Error("Room capacity reached");
  }

  let id = generateRoomId();
  while (await store.get(id)) id = generateRoomId();

  const now = Date.now();
  const room: RoomRecord = {
    id,
    hostName: normaliseHostName(hostName),
    createdAt: new Date(now),
    lastSeenAt: now,
  };

  await store.insert(room);
  return room;
}

export async function getRoom(roomId: string): Promise<RoomRecord | undefined> {
  return requireService().store.get(roomId);
}

export async function toPublicRoom(room: RoomRecord): Promise<PublicRoom> {
  const { presence } = requireService();
  return {
    id: room.id,
    hostName: room.hostName,
    participantCount: await presence.count(room.id),
    createdAt: room.createdAt.toISOString(),
  };
}

export type JoinResult =
  | { ok: true; room: RoomRecord; isFirstParticipant: boolean }
  | { ok: false; reason: "not-found" | "full" };

export async function joinRoom(roomId: string, socketId: string): Promise<JoinResult> {
  const { store, presence } = requireService();

  const room = await store.get(roomId);
  if (!room) return { ok: false, reason: "not-found" };

  const current = await presence.peers(roomId);

  // Re-joining after a reconnect: idempotent.
  if (current.includes(socketId)) {
    await store.touch(roomId, Date.now());
    return { ok: true, room, isFirstParticipant: current.length === 1 };
  }

  if (current.length >= MAX_PARTICIPANTS) return { ok: false, reason: "full" };

  // Add first, then verify: two simultaneous joins can never both squeeze past
  // the limit, because the loser sees size > MAX and removes itself.
  const size = await presence.add(roomId, socketId);
  if (size > MAX_PARTICIPANTS) {
    await presence.remove(roomId, socketId);
    return { ok: false, reason: "full" };
  }

  await store.touch(roomId, Date.now());
  return { ok: true, room, isFirstParticipant: size === 1 };
}

export async function leaveRoom(roomId: string, socketId: string): Promise<void> {
  const { store, presence } = requireService();
  await presence.remove(roomId, socketId);
  await store.touch(roomId, Date.now());
}

export async function roomPeers(roomId: string): Promise<string[]> {
  return requireService().presence.peers(roomId);
}

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
    if ((await presence.count(id)) === 0) {
      if (await store.remove(id)) removed += 1;
    }
  }

  if (removed > 0) logger.info({ removed }, "Expired rooms swept");
  return removed;
}

export function roomLimits() {
  return { maxRooms: MAX_ROOMS, maxParticipants: MAX_PARTICIPANTS, ttlMs: DEFAULT_TTL_MS };
}
