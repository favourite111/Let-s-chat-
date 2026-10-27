import type { ParticipantRecord, PresenceStore } from "./types";

/**
 * In-process presence. Correct for a single instance, which is what a VPS runs.
 * Nothing here needs to survive a restart: if the process dies, the WebRTC
 * connections die with it and both peers reconnect and re-join.
 *
 * Records are keyed by participantId, so a reconnect replaces the seat rather
 * than adding one.
 */
export class MemoryPresence implements PresenceStore {
  readonly kind = "memory" as const;
  private rooms = new Map<string, Map<string, ParticipantRecord>>();

  private room(roomId: string): Map<string, ParticipantRecord> {
    let map = this.rooms.get(roomId);
    if (!map) {
      map = new Map();
      this.rooms.set(roomId, map);
    }
    return map;
  }

  async upsert(roomId: string, participant: ParticipantRecord): Promise<void> {
    this.room(roomId).set(participant.participantId, { ...participant });
  }

  async get(roomId: string, participantId: string): Promise<ParticipantRecord | undefined> {
    const record = this.rooms.get(roomId)?.get(participantId);
    return record ? { ...record } : undefined;
  }

  async remove(roomId: string, participantId: string): Promise<void> {
    const map = this.rooms.get(roomId);
    if (!map) return;
    map.delete(participantId);
    if (map.size === 0) this.rooms.delete(roomId);
  }

  async markDisconnected(
    roomId: string,
    participantId: string,
    at: number,
    socketId?: string | null,
  ): Promise<boolean> {
    const record = this.rooms.get(roomId)?.get(participantId);
    if (!record) return false;
    // Someone already reclaimed this seat on a newer socket: this old socket
    // dying says nothing about the current session.
    if (socketId !== undefined && record.socketId !== null && record.socketId !== socketId) {
      return false;
    }
    record.socketId = null;
    record.disconnectedAt = at;
    return true;
  }

  async list(roomId: string): Promise<ParticipantRecord[]> {
    return [...(this.rooms.get(roomId)?.values() ?? [])].map((p) => ({ ...p }));
  }

  async countConnected(roomId: string): Promise<number> {
    let n = 0;
    for (const p of this.rooms.get(roomId)?.values() ?? []) {
      if (p.socketId) n += 1;
    }
    return n;
  }

  async clear(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }

  async close(): Promise<void> {
    this.rooms.clear();
  }
}
