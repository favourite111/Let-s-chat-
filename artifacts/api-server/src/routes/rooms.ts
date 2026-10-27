import { Router } from "express";
import { CreateRoomBody } from "@workspace/api-zod";
import {
  closeRoomByHost,
  createRoom,
  getRoom,
  toPublicRoom,
  verifyHost,
} from "../lib/rooms";
import { closeRoomConnections } from "../lib/signaling";

const router = Router();

/** Wrap an async handler so rejected promises reach the error middleware. */
const wrap =
  (fn: (req: any, res: any) => Promise<void>) =>
  (req: any, res: any, next: any): void => {
    fn(req, res).catch(next);
  };

/**
 * Host credentials travel in headers rather than the URL, so they stay out of
 * access logs and browser history.
 */
function hostCredentials(req: any): { participantId: string | null; secret: string | null } {
  const participantId = req.get("x-participant-id") ?? null;
  const secret = req.get("x-host-secret") ?? null;
  return { participantId, secret };
}

router.post(
  "/rooms",
  wrap(async (req, res) => {
    // Validate with the schema generated from the OpenAPI contract.
    const parsed = CreateRoomBody.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    try {
      const room = await createRoom({
        hostName: parsed.data.hostName,
        hostParticipantId: parsed.data.hostParticipantId,
        hostSecret: parsed.data.hostSecret,
      });
      res.status(201).json(await toPublicRoom(room));
    } catch (err) {
      if (err instanceof Error && err.message === "Room capacity reached") {
        res.status(503).json({ error: "Server at capacity, try again later" });
        return;
      }
      throw err;
    }
  }),
);

router.get(
  "/rooms/:roomId",
  wrap(async (req, res) => {
    const room = await getRoom(req.params.roomId);

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    res.json(await toPublicRoom(room));
  }),
);

/**
 * Close (delete) a room. Host-only.
 *
 * This used to be unauthenticated, which meant any passer-by who learned a room
 * id could destroy someone else's call. It now requires the same host secret
 * that authorizes `end-call` over the socket.
 */
router.delete(
  "/rooms/:roomId",
  wrap(async (req, res) => {
    const room = await getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    const { participantId, secret } = hostCredentials(req);
    if (!participantId || !verifyHost(room, participantId, secret)) {
      res.status(403).json({ error: "Only the room's host can close it" });
      return;
    }

    const closed = await closeRoomByHost(req.params.roomId, participantId, secret);
    if (!closed.ok) {
      res.status(409).json({ error: `Cannot close room: ${closed.reason}` });
      return;
    }

    // The host may be closing the room from a page whose socket is
    // reconnecting, so the socket layer cannot be assumed to have broadcast
    // this. Notify and evict from here as well; it is idempotent.
    await closeRoomConnections(req.params.roomId);

    res.status(204).end();
  }),
);

export default router;
