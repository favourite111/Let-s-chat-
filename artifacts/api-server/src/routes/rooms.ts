import { Router } from "express";
import { randomUUID } from "crypto";

const router = Router();

interface Room {
  id: string;
  hostName: string | null;
  participantCount: number;
  createdAt: Date;
}

const roomStore = new Map<string, Room>();

router.post("/rooms", (req, res) => {
  const { hostName } = req.body ?? {};
  const id = randomUUID().slice(0, 8);

  const room: Room = {
    id,
    hostName: hostName ?? null,
    participantCount: 0,
    createdAt: new Date(),
  };

  roomStore.set(id, room);

  res.status(201).json({
    id: room.id,
    hostName: room.hostName,
    participantCount: room.participantCount,
    createdAt: room.createdAt.toISOString(),
  });
});

router.get("/rooms/:roomId", (req, res) => {
  const room = roomStore.get(req.params.roomId);

  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  res.json({
    id: room.id,
    hostName: room.hostName,
    participantCount: room.participantCount,
    createdAt: room.createdAt.toISOString(),
  });
});

export default router;
