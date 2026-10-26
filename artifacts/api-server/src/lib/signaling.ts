import type { Server as SocketIOServer } from "socket.io";
import type { Socket } from "socket.io";
import { logger } from "./logger";
import { getRoom, joinRoom, leaveRoom } from "./rooms";

/**
 * Socket.IO signaling relay for 1-on-1 WebRTC.
 *
 * Hard rules enforced here:
 *  - every inbound payload is validated before use (a malformed message must
 *    never be able to throw — the old code crashed the process on
 *    `emit("ice-candidate", null)`);
 *  - a socket may only join a room that actually exists in the room store;
 *  - relay targets must be sockets that share a room with the sender, so the
 *    server cannot be used as an open message bus;
 *  - each handler is wrapped so a bug degrades to a logged error, not a crash.
 */

const MAX_PEERS_PER_ROOM = 2;
const MAX_JOIN_ATTEMPTS_PER_MINUTE = 20;
const MAX_RELAYS_PER_MINUTE = 600;

type RelayPayload = {
  to: string;
  offer?: unknown;
  answer?: unknown;
  candidate?: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** Parse `{ to, <field> }` and reject anything that does not have the shape. */
function parseRelay(payload: unknown, field: "offer" | "answer" | "candidate"): RelayPayload | null {
  if (!isPlainObject(payload)) return null;
  const to = payload["to"];
  if (!isNonEmptyString(to)) return null;

  const body = payload[field];
  if (body === undefined || body === null) return null;

  return { to, [field]: body } as RelayPayload;
}

/** Cheap sliding-window limiter; per-process and per-socket. */
function createRateLimiter(limit: number, windowMs: number) {
  let windowStart = Date.now();
  let count = 0;
  return function allow(): boolean {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= limit;
  };
}

/** Wrap an async/sync handler so a throw never escapes to the process. */
function safeHandler<T extends unknown[]>(
  socket: Socket,
  event: string,
  handler: (...args: T) => void | Promise<void>,
) {
  return (...args: T) => {
    try {
      const result = handler(...args);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err: unknown) => {
          logger.error({ err, event, socketId: socket.id }, "Signaling handler rejected");
        });
      }
    } catch (err) {
      logger.error({ err, event, socketId: socket.id }, "Signaling handler threw");
    }
  };
}

export function setupSignaling(io: SocketIOServer) {
  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    /** The room this socket is currently signalling in (at most one). */
    let currentRoomId: string | null = null;

    const allowJoin = createRateLimiter(MAX_JOIN_ATTEMPTS_PER_MINUTE, 60_000);
    const allowRelay = createRateLimiter(MAX_RELAYS_PER_MINUTE, 60_000);

    /** Only relay to sockets that are in the same room as the caller. */
    function peerInSameRoom(targetId: string): boolean {
      if (currentRoomId === null) return false;
      const room = getRoom(currentRoomId);
      if (!room) return false;
      return room.participants.has(targetId);
    }

    socket.on(
      "join-room",
      safeHandler(socket, "join-room", (roomId: unknown) => {
        if (!allowJoin()) {
          socket.emit("join-error", { reason: "rate-limited" });
          return;
        }
        if (!isNonEmptyString(roomId)) {
          socket.emit("join-error", { reason: "invalid-room" });
          return;
        }

        // Leave a previously joined room before joining another.
        if (currentRoomId !== null && currentRoomId !== roomId) {
          leaveRoom(currentRoomId, socket.id);
          socket.leave(currentRoomId);
          socket.to(currentRoomId).emit("user-disconnected", socket.id);
          currentRoomId = null;
        }

        const result = joinRoom(roomId, socket.id, MAX_PEERS_PER_ROOM);

        if (!result.ok) {
          if (result.reason === "not-found") {
            // Rooms must exist in the store: no more "ghost rooms".
            socket.emit("join-error", { reason: "room-not-found" });
            logger.info({ socketId: socket.id, roomId }, "Join rejected: unknown room");
          } else {
            socket.emit("room-full");
            logger.info({ socketId: socket.id, roomId }, "Join rejected: room full");
          }
          return;
        }

        currentRoomId = roomId;
        socket.join(roomId);

        // Tell the newcomer who is already here — the existing peer creates the
        // offer, which keeps negotiation deterministic for exactly 2 peers.
        const others = [...result.room.participants].filter((id) => id !== socket.id);
        socket.emit("room-joined", { roomId, peers: others });

        for (const peer of others) {
          io.to(peer).emit("user-connected", socket.id);
        }

        logger.info(
          { socketId: socket.id, roomId, participants: result.room.participants.size },
          "User joined room",
        );
      }),
    );

    socket.on(
      "offer",
      safeHandler(socket, "offer", (payload: unknown) => {
        if (!allowRelay()) return;
        const parsed = parseRelay(payload, "offer");
        if (!parsed || !peerInSameRoom(parsed.to)) return;
        socket.to(parsed.to).emit("offer", { offer: parsed.offer, from: socket.id });
      }),
    );

    socket.on(
      "answer",
      safeHandler(socket, "answer", (payload: unknown) => {
        if (!allowRelay()) return;
        const parsed = parseRelay(payload, "answer");
        if (!parsed || !peerInSameRoom(parsed.to)) return;
        socket.to(parsed.to).emit("answer", { answer: parsed.answer, from: socket.id });
      }),
    );

    socket.on(
      "ice-candidate",
      safeHandler(socket, "ice-candidate", (payload: unknown) => {
        if (!allowRelay()) return;
        const parsed = parseRelay(payload, "candidate");
        if (!parsed || !peerInSameRoom(parsed.to)) return;
        socket.to(parsed.to).emit("ice-candidate", { candidate: parsed.candidate, from: socket.id });
      }),
    );

    /** Mute / camera-off indicators for the peer. */
    socket.on(
      "media-state",
      safeHandler(socket, "media-state", (payload: unknown) => {
        if (!isPlainObject(payload)) return;
        if (currentRoomId === null) return;
        const state = {
          audio: payload["audio"] === true,
          video: payload["video"] === true,
        };
        socket.to(currentRoomId).emit("media-state", { ...state, from: socket.id });
      }),
    );

    socket.on(
      "ping",
      safeHandler(socket, "ping", () => {
        socket.emit("pong");
      }),
    );

    socket.on(
      "disconnecting",
      safeHandler(socket, "disconnecting", () => {
        if (currentRoomId === null) return;
        leaveRoom(currentRoomId, socket.id);
        socket.to(currentRoomId).emit("user-disconnected", socket.id);
        logger.info({ socketId: socket.id, roomId: currentRoomId }, "User left room");
        currentRoomId = null;
      }),
    );

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, reason }, "Socket disconnected");
    });
  });
}

export type { Socket };
