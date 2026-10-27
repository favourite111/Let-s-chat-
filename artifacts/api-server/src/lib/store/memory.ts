import type { RoomRecord, RoomStore } from "./types";

/** Volatile room store. Used for tests and as a last-resort fallback. */
export class MemoryRoomStore implements RoomStore {
  readonly kind = "memory" as const;
  private rooms = new Map<string, RoomRecord>();

  async init(): Promise<void> {}

  async insert(room: RoomRecord): Promise<void> {
    this.rooms.set(room.id, {
      ...room,
      removedParticipantIds: [...room.removedParticipantIds],
    });
  }

  async get(id: string): Promise<RoomRecord | undefined> {
    const room = this.rooms.get(id);
    return room ? { ...room, removedParticipantIds: [...room.removedParticipantIds] } : undefined;
  }

  async touch(id: string, at: number): Promise<void> {
    const room = this.rooms.get(id);
    if (room) room.lastSeenAt = at;
  }

  async remove(id: string): Promise<boolean> {
    return this.rooms.delete(id);
  }

  async count(): Promise<number> {
    return this.rooms.size;
  }

  async listOlderThan(cutoff: number, limit = 500): Promise<string[]> {
    const stale: string[] = [];
    for (const [id, room] of this.rooms) {
      if (room.lastSeenAt < cutoff) stale.push(id);
      if (stale.length >= limit) break;
    }
    return stale;
  }

  async setClosed(id: string, at: number): Promise<boolean> {
    const room = this.rooms.get(id);
    if (!room) return false;
    room.closedAt = at;
    return true;
  }

  async addRemoved(id: string, participantId: string): Promise<boolean> {
    const room = this.rooms.get(id);
    if (!room) return false;
    if (!room.removedParticipantIds.includes(participantId)) {
      room.removedParticipantIds.push(participantId);
    }
    return true;
  }

  async close(): Promise<void> {
    this.rooms.clear();
  }
}
