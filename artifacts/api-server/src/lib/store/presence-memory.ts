import type { PresenceStore } from "./types";

/**
 * In-process presence. Correct for a single instance, which is what a VPS runs.
 * Nothing here needs to survive a restart: if the process dies, the WebRTC
 * connections die with it and both peers reconnect and re-join.
 */
export class MemoryPresence implements PresenceStore {
  readonly kind = "memory" as const;
  private rooms = new Map<string, Set<string>>();

  async add(roomId: string, socketId: string): Promise<number> {
    let set = this.rooms.get(roomId);
    if (!set) {
      set = new Set();
      this.rooms.set(roomId, set);
    }
    set.add(socketId);
    return set.size;
  }

  async remove(roomId: string, socketId: string): Promise<number> {
    const set = this.rooms.get(roomId);
    if (!set) return 0;
    set.delete(socketId);
    const size = set.size;
    if (size === 0) this.rooms.delete(roomId);
    return size;
  }

  async peers(roomId: string): Promise<string[]> {
    return [...(this.rooms.get(roomId) ?? [])];
  }

  async count(roomId: string): Promise<number> {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  async clear(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }

  async close(): Promise<void> {
    this.rooms.clear();
  }
}
