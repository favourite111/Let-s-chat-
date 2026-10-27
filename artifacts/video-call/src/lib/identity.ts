/**
 * Who this browser is, across reloads and reconnects.
 *
 * Two things are kept in localStorage:
 *
 *  1. **A participant id** — minted once per browser and presented on every
 *     join. The server keys presence by this, so a reload reclaims the same
 *     seat instead of looking like a new person and filling the room with
 *     ghosts of its own occupants.
 *
 *  2. **A host secret per room** — minted when this browser creates a room and
 *     never sent anywhere except to that room's server as proof of ownership.
 *     Only its hash is stored server-side. Lose it and you lose host powers,
 *     which is why it lives in localStorage rather than in memory.
 */

const PARTICIPANT_KEY = "videocall:participant-id";
const HOST_SECRET_PREFIX = "videocall:host-secret:";

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable id for this browser. Survives reloads, tabs and reconnects. */
export function getParticipantId(): string {
  try {
    const existing = localStorage.getItem(PARTICIPANT_KEY);
    if (existing && existing.length >= 8) return existing;
    const minted = `p_${randomHex(16)}`;
    localStorage.setItem(PARTICIPANT_KEY, minted);
    return minted;
  } catch {
    // Private mode / storage disabled: fall back to an in-memory id for this
    // page load. Reloads will look like a new person, which is the pre-existing
    // behaviour rather than a crash.
    return `p_${randomHex(16)}`;
  }
}

/** Mint a host secret. Returned once, at room creation. */
export function createHostSecret(): string {
  return randomHex(32);
}

export function storeHostSecret(roomId: string, secret: string): void {
  try {
    localStorage.setItem(`${HOST_SECRET_PREFIX}${roomId}`, secret);
  } catch {
    /* storage disabled — the room simply won't have host controls later */
  }
}

export function getHostSecret(roomId: string): string | null {
  try {
    return localStorage.getItem(`${HOST_SECRET_PREFIX}${roomId}`);
  } catch {
    return null;
  }
}

export function clearHostSecret(roomId: string): void {
  try {
    localStorage.removeItem(`${HOST_SECRET_PREFIX}${roomId}`);
  } catch {
    /* ignore */
  }
}
