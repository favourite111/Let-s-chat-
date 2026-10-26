import { Router } from "express";
import { CreateRoomBody } from "@workspace/api-zod";
import { createRoom, deleteRoom, getRoom, toPublicRoom } from "../lib/rooms";

const router = Router();

router.post("/rooms", (req, res) => {
  // Validate with the schema generated from the OpenAPI contract.
  const parsed = CreateRoomBody.safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    const room = createRoom(parsed.data.hostName);
    res.status(201).json(toPublicRoom(room));
  } catch (err) {
    if (err instanceof Error && err.message === "Room capacity reached") {
      res.status(503).json({ error: "Server at capacity, try again later" });
      return;
    }
    throw err;
  }
});

router.get("/rooms/:roomId", (req, res) => {
  const room = getRoom(req.params.roomId);

  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  res.json(toPublicRoom(room));
});

router.delete("/rooms/:roomId", (req, res) => {
  const room = getRoom(req.params.roomId);

  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  deleteRoom(req.params.roomId);
  res.status(204).end();
});

export default router;
