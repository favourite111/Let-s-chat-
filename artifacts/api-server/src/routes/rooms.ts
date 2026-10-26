import { Router } from "express";
import { CreateRoomBody } from "@workspace/api-zod";
import { createRoom, deleteRoom, getRoom, toPublicRoom } from "../lib/rooms";

const router = Router();

/** Wrap an async handler so rejected promises reach the error middleware. */
const wrap =
  (fn: (req: any, res: any) => Promise<void>) =>
  (req: any, res: any, next: any): void => {
    fn(req, res).catch(next);
  };

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
      const room = await createRoom(parsed.data.hostName);
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

router.delete(
  "/rooms/:roomId",
  wrap(async (req, res) => {
    const removed = await deleteRoom(req.params.roomId);

    if (!removed) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    res.status(204).end();
  }),
);

export default router;
