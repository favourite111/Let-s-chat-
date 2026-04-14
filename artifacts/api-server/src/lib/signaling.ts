import type { Server as SocketIOServer } from "socket.io";
import { logger } from "./logger";

const rooms = new Map<string, Set<string>>();

export function setupSignaling(io: SocketIOServer) {
  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    socket.on("join-room", (roomId: string) => {
      if (!roomId || typeof roomId !== "string") return;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }

      const room = rooms.get(roomId)!;

      if (room.size >= 2) {
        socket.emit("room-full");
        return;
      }

      room.add(socket.id);
      socket.join(roomId);

      const otherUsers = [...room].filter((id) => id !== socket.id);
      otherUsers.forEach((userId) => {
        socket.to(userId).emit("user-connected", socket.id);
      });

      logger.info({ socketId: socket.id, roomId, participants: room.size }, "User joined room");
    });

    socket.on("offer", ({ offer, to }: { offer: unknown; to: string }) => {
      socket.to(to).emit("offer", { offer, from: socket.id });
    });

    socket.on("answer", ({ answer, to }: { answer: unknown; to: string }) => {
      socket.to(to).emit("answer", { answer, from: socket.id });
    });

    socket.on("ice-candidate", ({ candidate, to }: { candidate: unknown; to: string }) => {
      socket.to(to).emit("ice-candidate", { candidate, from: socket.id });
    });

    socket.on("disconnecting", () => {
      socket.rooms.forEach((roomId) => {
        if (roomId === socket.id) return;
        const room = rooms.get(roomId);
        if (room) {
          room.delete(socket.id);
          if (room.size === 0) {
            rooms.delete(roomId);
          }
          socket.to(roomId).emit("user-disconnected", socket.id);
        }
      });
    });

    socket.on("disconnect", () => {
      logger.info({ socketId: socket.id }, "Socket disconnected");
    });
  });
}
