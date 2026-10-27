import type { Server as SocketIOServer, Socket } from "socket.io";
import { logger } from "./logger";
import {
  abandonRoom,
  closeRoomByHost,
  joinRoom,
  leaveRoom,
  normaliseParticipantId,
  removeParticipantByHost,
  roomParticipants,
  roomSockets,
  toPublicParticipants,
  verifyHost,
  type JoinFailure,
} from "./rooms";

/**
 * Socket.IO signaling relay for 1-on-1 WebRTC.
 *
 * Rules enforced here:
 *  - every inbound payload is validated before use (a malformed message must
 *    never be able to throw — `emit("ice-candidate", null)` used to exit the
 *    process);
 *  - a socket may only join a room that exists in the durable room store;
 *  - peers are addressed by **participant id**, not socket id, so a peer that
 *    reconnects is still the same address;
 *  - relay targets must actually share a room with the sender, so the server
 *    cannot be used as an open message bus;
 *  - host-only actions re-verify the host secret on every call — the client
 *    having drawn a button is not authorization;
 *  - each handler is wrapped, so a bug degrades to a logged error, not a crash.
 */

const MAX_RELAYS_PER_MINUTE = 600;

/**
 * The server, once attached. Kept module-level so the REST close path can
 * notify the room too — the host may end the call from a page whose socket is
 * mid-reconnect, in which case the DELETE is the only signal the server gets.
 */
let signalingServer: SocketIOServer | null = null;
const MAX_JOIN_ATTEMPTS_PER_MINUTE = 20;

type RelayField = "offer" | "answer" | "candidate";

interface RelayPayload {
  to: string;
  body: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function parseRelay(payload: unknown, field: RelayField): RelayPayload | null {
  if (!isPlainObject(payload)) return null;

  // Accept the identity-based form {"to": participantId}. A bare socket id is
  // rejected: it cannot survive a reconnect, which is the whole point.
  const to = payload["to"];
  if (!isNonEmptyString(to)) return null;

  const body = payload[field];
  if (body === undefined || body === null) return null;

  return { to, body };
}

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

/** Map a join refusal onto the event the client already knows how to handle. */
function refuseJoin(socket: Socket, reason: JoinFailure, roomId: string): void {
  switch (reason) {
    case "not-found":
      socket.emit("join-error", { reason: "room-not-found" });
      break;
    case "closed":
      socket.emit("room-closed", { reason: "host-ended-call" });
      break;
    case "removed":
      socket.emit("removed", { reason: "removed-by-host" });
      break;
    case "host-auth-failed":
      socket.emit("join-error", { reason: "host-auth-failed" });
      break;
    case "full":
      socket.emit("room-full");
      break;
    default:
      socket.emit("join-error", { reason: "invalid-room" });
  }
  logger.info({ socketId: socket.id, roomId, reason }, "Join rejected");
}

/**
 * Tell everyone in a room that it is closed, then unsubscribe their sockets.
 * Safe to call twice: the second call simply finds an empty room.
 */
export async function closeRoomConnections(roomId: string): Promise<void> {
  const io = signalingServer;
  if (!io) return;

  io.to(roomId).emit("room-closed", { reason: "host-ended-call" });

  for (const participant of await roomParticipants(roomId)) {
    if (!participant.socketId) continue;
    io.sockets.sockets.get(participant.socketId)?.leave(roomId);
  }
}

export function setupSignaling(io: SocketIOServer) {
  signalingServer = io;

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    let currentRoomId: string | null = null;
    let currentParticipantId: string | null = null;
    /** Kept only in memory for this session, to re-authorize host actions. */
    let hostSecret: string | null = null;
    let isHost = false;

    const allowJoin = createRateLimiter(MAX_JOIN_ATTEMPTS_PER_MINUTE, 60_000);
    const allowRelay = createRateLimiter(MAX_RELAYS_PER_MINUTE, 60_000);

    /** Relay only to participants that actually share a room with the caller. */
    async function socketIdForPeer(participantId: string): Promise<string | null> {
      if (currentRoomId === null) return null;
      const sockets = await roomSockets(currentRoomId);
      return sockets.get(participantId) ?? null;
    }

    /** Tell everyone else in the room what the roster looks like now. */
    async function broadcastRoster(roomId: string): Promise<void> {
      const participants = await roomParticipants(roomId);
      // Only people who are actually here. A seat held for the grace period is
      // an internal detail and must not appear as a third person in the UI.
      const connected = participants.filter((p) => p.socketId);
      const roster = toPublicParticipants(connected);
      for (const participant of connected) {
        if (!participant.socketId) continue;
        io.to(participant.socketId).emit("room-state", {
          participants: roster,
          count: connected.length,
        });
      }
    }

    socket.on(
      "join-room",
      safeHandler(socket, "join-room", async (payload: unknown) => {
        if (!allowJoin()) {
          socket.emit("join-error", { reason: "rate-limited" });
          return;
        }

        // Accept both the object form and a bare room id for robustness, but
        // identity is mandatory: an anonymous join cannot reclaim a seat.
        const roomId = isPlainObject(payload)
          ? payload["roomId"]
          : typeof payload === "string"
            ? payload
            : null;

        if (!isNonEmptyString(roomId)) {
          socket.emit("join-error", { reason: "invalid-room" });
          return;
        }

        const participantId = isPlainObject(payload)
          ? normaliseParticipantId(payload["participantId"])
          : null;

        if (!participantId) {
          socket.emit("join-error", { reason: "invalid-participant" });
          return;
        }

        const suppliedSecret = isPlainObject(payload) ? payload["hostSecret"] : null;
        const displayName = isPlainObject(payload) ? payload["displayName"] : null;

        // Switching rooms in the same socket: leave the old one first.
        if (currentRoomId !== null && currentRoomId !== roomId) {
          await leaveRoom(currentRoomId, currentParticipantId ?? "", socket.id);
          socket.leave(currentRoomId);
          socket.to(currentRoomId).emit("user-disconnected", {
            participantId: currentParticipantId,
          });
          await broadcastRoster(currentRoomId);
          currentRoomId = null;
        }

        const result = await joinRoom(roomId, {
          participantId,
          socketId: socket.id,
          hostSecret: suppliedSecret,
          displayName,
        });

        if (!result.ok) {
          refuseJoin(socket, result.reason, roomId);
          return;
        }

        currentRoomId = roomId;
        currentParticipantId = participantId;
        hostSecret = typeof suppliedSecret === "string" ? suppliedSecret : null;
        isHost = result.isHost;

        socket.join(roomId);

        const participants = await roomParticipants(roomId);
        socket.emit("room-joined", {
          roomId,
          self: { participantId, role: result.participant.role, isHost: result.isHost },
          participants: toPublicParticipants(participants),
          reclaimed: result.reclaimed,
          isHost: result.isHost,
        });

        // Tell the others a peer is present. This fires on a reclaim too: the
        // peer's old connection to this person is dead, so it must renegotiate.
        for (const other of result.others) {
          if (!other.socketId) continue;
          io.to(other.socketId).emit("user-connected", { participantId });
        }

        await broadcastRoster(roomId);

        logger.info(
          { socketId: socket.id, roomId, participantId, isHost, reclaimed: result.reclaimed },
          "User joined room",
        );
      }),
    );

    for (const field of ["offer", "answer", "ice-candidate"] as const) {
      socket.on(
        field,
        safeHandler(socket, field, async (payload: unknown) => {
          if (!allowRelay()) return;

          // "ice-candidate" carries `candidate`; the other two match their name.
          const relayField: RelayField = field === "ice-candidate" ? "candidate" : field;
          const parsed = parseRelay(payload, relayField);
          if (!parsed) return;

          const targetSocketId = await socketIdForPeer(parsed.to);
          if (!targetSocketId) return;

          io.to(targetSocketId).emit(field, {
            [relayField]: parsed.body,
            from: currentParticipantId,
          });
        }),
      );
    }

    /** Mute / camera-off indicators for the peer. */
    socket.on(
      "media-state",
      safeHandler(socket, "media-state", (payload: unknown) => {
        if (!isPlainObject(payload) || currentRoomId === null) return;
        socket.to(currentRoomId).emit("media-state", {
          audio: payload["audio"] === true,
          video: payload["video"] === true,
          from: currentParticipantId,
        });
      }),
    );

    // ── host-only actions ───────────────────────────────────────────────────
    //
    // Both re-verify the host secret against the stored room rather than
    // trusting the `isHost` flag alone, so a forged client cannot act as host
    // even if it lies about its role during the join handshake.

    socket.on(
      "end-call",
      safeHandler(socket, "end-call", async () => {
        if (!currentRoomId || !currentParticipantId) return;

        const roomId = currentRoomId;
        // Capture who is here *before* closing: closeRoomByHost clears presence,
        // so afterwards there is nobody left to address.
        const sockets = [...(await roomSockets(roomId)).values()];
        const result = await closeRoomByHost(roomId, currentParticipantId, hostSecret);

        if (!result.ok) {
          socket.emit("host-action-error", { action: "end-call", reason: result.reason });
          logger.warn(
            { socketId: socket.id, roomId, participantId: currentParticipantId, isHost },
            "end-call refused",
          );
          return;
        }

        io.to(roomId).emit("room-closed", { reason: "host-ended-call" });
        // Evict every socket so no lingering client stays subscribed.
        for (const socketId of sockets) io.sockets.sockets.get(socketId)?.leave(roomId);
        logger.info({ roomId, by: currentParticipantId }, "Call ended by host");
      }),
    );

    socket.on(
      "remove-participant",
      safeHandler(socket, "remove-participant", async (payload: unknown) => {
        if (!currentRoomId || !currentParticipantId) return;

        const targetParticipantId = isPlainObject(payload)
          ? normaliseParticipantId(payload["participantId"])
          : null;

        if (!targetParticipantId) {
          socket.emit("host-action-error", { action: "remove-participant", reason: "target-not-found" });
          return;
        }

        const roomId = currentRoomId;
        const result = await removeParticipantByHost(
          roomId,
          currentParticipantId,
          hostSecret,
          targetParticipantId,
        );

        if (!result.ok) {
          socket.emit("host-action-error", {
            action: "remove-participant",
            reason: result.reason,
          });
          logger.warn(
            { socketId: socket.id, roomId, by: currentParticipantId, targetParticipantId },
            "remove-participant refused",
          );
          return;
        }

        if (result.socketId) {
          const target = io.sockets.sockets.get(result.socketId);
          target?.emit("removed", { reason: "removed-by-host" });
          target?.leave(roomId);
          target?.disconnect(true);
        }

        socket.emit("participant-removed", { participantId: targetParticipantId });
        await broadcastRoster(roomId);
        logger.info({ roomId, removed: targetParticipantId }, "Participant removed from room");
      }),
    );

    socket.on(
      "ping",
      safeHandler(socket, "ping", () => {
        socket.emit("pong");
      }),
    );

    /**
     * Explicit departure (the Leave button). Frees the seat immediately rather
     * than waiting out the grace period, because the person is not coming back.
     */
    socket.on(
      "leave",
      safeHandler(socket, "leave", async () => {
        if (!currentRoomId || !currentParticipantId) return;
        const roomId = currentRoomId;
        const participantId = currentParticipantId;

        await abandonRoom(roomId, participantId);
        socket.to(roomId).emit("user-disconnected", { participantId });
        socket.leave(roomId);
        await broadcastRoster(roomId);

        currentRoomId = null;
        currentParticipantId = null;
        logger.info({ socketId: socket.id, roomId, participantId }, "User left room");
      }),
    );

    socket.on(
      "disconnecting",
      safeHandler(socket, "disconnecting", async () => {
        if (currentRoomId === null || currentParticipantId === null) return;
        const roomId = currentRoomId;
        const participantId = currentParticipantId;
        currentRoomId = null;

        // Keeps the seat for the grace period so a reconnect reclaims it. The
        // socket id makes this a no-op if the participant already reconnected
        // on a newer socket before this one was reaped.
        const changed = await leaveRoom(roomId, participantId, socket.id);
        if (changed) {
          socket.to(roomId).emit("user-disconnected", { participantId });
          await broadcastRoster(roomId);
        }

        logger.info({ socketId: socket.id, roomId, participantId }, "User disconnected");
      }),
    );

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, reason }, "Socket disconnected");
    });
  });
}

/** Re-exported for tests that need to assert host authorization directly. */
export { verifyHost };
