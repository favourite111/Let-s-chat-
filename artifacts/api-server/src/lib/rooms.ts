import { randomInt } from "crypto";

/**
 * Single source of truth for rooms.
 *
 * The REST API (`/api/rooms`) and the Socket.IO signaling layer both read and
 * write through this module, so a room that "exists" for HTTP is exactly the
 * room that can accept a peer connection — and `participantCount` is real.
 *
 * Storage is in-process. That is fine for a single instance, but rooms do not
 * survive a restart and two instances will not see each other. See
 * `docs/ARCHITECTURE.md` before scaling horizontally (swap this module for a
 * Postgres + Redis implementation behind the same interface).
 */

/** Unambiguous alphabet (Crockford base32, no I/L/O/U). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 12 chars of 32-symbol alphabet = 60 bits of entropy (~1.15e18 rooms). */
export const ROOM_ID_LENGTH = 12;

/** Default lifetime of an empty room (2 hours). */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** Sweep interval for expired rooms. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface RoomRecord {
  id: string;
  hostName: string | null;
  createdAt: Date;
  /** Socket IDs currently joined, in join order. */
  participants: Set<string>;
  /** Last time anybody touched this room (used for TTL). */
  lastSeenAt: number;
}

export interface PublicRoom {
  id: string;
  hostName: string | null;
  participantCount: number;
  createdAt: string;
}

const MAX_HOST_NAME = 64;
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 10_000);

const rooms = new Map<string, RoomRecord>();

export function generateRoomId(): string {
  let id = "";
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
    id += ALPHABET[randomInt(ALPHABET.length)];
  }
  return id;
}

export function normaliseHostName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_HOST_NAME);
  return trimmed.length > 0 ? trimmed : null;
}

export function createRoom(hostName: unknown): RoomRecord {
  if (rooms.size >= MAX_ROOMS) {
    sweepExpired();
    if (rooms.size >= MAX_ROOMS) {
      throw new Error("Room capacity reached");
    }
  }

  let id = generateRoomId();
  // Astronomically unlikely, but never hand out a duplicate.
  while (rooms.has(id)) id = generateRoomId();

  const room: RoomRecord = {
    id,
    hostName: normaliseHostName(hostName),
    createdAt: new Date(),
    participants: new Set(),
    lastSeenAt: Date.now(),
  };

  rooms.set(id, room);
  return room;
}

export function getRoom(roomId: string): RoomRecord | undefined {
  return rooms.get(roomId);
}

export function toPublicRoom(room: RoomRecord): PublicRoom {
  return {
    id: room.id,
    hostName: room.hostName,
    participantCount: room.participants.size,
    createdAt: room.createdAt.toISOString(),
  };
}

export type JoinResult =
  | { ok: true; room: RoomRecord; isFirstParticipant: boolean }
  | { ok: false; reason: "not-found" | "full" };

export function joinRoom(
  roomId: string,
  socketId: string,
  maxParticipants = 2,
): JoinResult {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: "not-found" };

  // Re-joining (e.g. after a reconnect that reused the same socket) is a no-op.
  if (room.participants.has(socketId)) {
    room.lastSeenAt = Date.now();
    return { ok: true, room, isFirstParticipant: room.participants.size === 1 };
  }

  if (room.participants.size >= maxParticipants) {
    return { ok: false, reason: "full" };
  }

  const isFirstParticipant = room.participants.size === 0;
  room.participants.add(socketId);
  room.lastSeenAt = Date.now();
  return { ok: true, room, isFirstParticipant };
}

export function leaveRoom(roomId: string, socketId: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;

  const removed = room.participants.delete(socketId);
  room.lastSeenAt = Date.now();

  // Keep empty rooms around briefly so a reload can re-enter the same link,
  // but let the TTL sweep reclaim them.
  return removed;
}

export function deleteRoom(roomId: string): boolean {
  return rooms.delete(roomId);
}

export function roomCount(): number {
  return rooms.size;
}

export function sweepExpired(now = Date.now(), ttlMs = DEFAULT_TTL_MS): number {
  let removed = 0;
  for (const [id, room] of rooms) {
    const empty = room.participants.size === 0;
    const expired = now - room.lastSeenAt > ttlMs;
    if (empty && expired) {
      rooms.delete(id);
      removed += 1;
    }
  }
  return removed;
}

const sweepTimer = setInterval(() => {
  const removed = sweepExpired();
  if (removed > 0) {
    // eslint-disable-next-line no-console -- logger lives in ./logger; avoid import cycle
    console.log(JSON.stringify({ level: 30, msg: "Expired rooms swept", removed }));
  }
}, SWEEP_INTERVAL_MS);

// Never keep the process alive just for the sweeper (matters for tests).
sweepTimer.unref?.();

/** Test helper: wipe all rooms. */
export function __resetRoomsForTests(): void {
  rooms.clear();
}
