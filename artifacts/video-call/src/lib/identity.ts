/**
 * Who this browser is, across reloads and reconnects.
 *
 * The rule is **one tab is one participant**:
 *
 *  1. **A participant id** lives in `sessionStorage`, which is per tab. A
 *     reload or a reconnect in the same tab keeps it, so the same seat is
 *     reclaimed. A second window gets its own id, so opening your own link in
 *     another window joins as a second person instead of colliding with
 *     yourself.
 *
 *     It used to live in `localStorage`, which every window of a profile
 *     shares: the second window presented the host's own id, reclaimed the
 *     host's seat, and the call never connected because there was nobody on
 *     the other end.
 *
 *  2. **A host secret per room** lives in `localStorage`, because it belongs to
 *     the person, not to the tab: it is what proves the room is yours. Only its
 *     hash is stored server-side.
 *
 *  3. **The host's participant id per room** is kept beside the secret, so a
 *     tab that holds the secret can present the host identity again when the
 *     host's seat is free (the old window was closed). While the host is still
 *     connected somewhere, other windows of the same browser are ordinary
 *     participants — otherwise two windows would fight over one seat.
 */

/**
 * One key name, two storages: the id itself lives in sessionStorage (per tab),
 * and the same key in localStorage is the old, shared-between-tabs copy, which
 * is deleted the moment it is seen.
 */
const PARTICIPANT_KEY = "videocall:participant-id";
const HOST_SECRET_PREFIX = "videocall:host-secret:";
const HOST_ID_PREFIX = "videocall:host-id:";

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mint(): string {
  return `p_${randomHex(16)}`;
}

/**
 * Stable id for **this tab**. Survives reloads; a new window/tab is a new
 * participant.
 */
export function getParticipantId(): string {
  try {
    const existing = sessionStorage.getItem(PARTICIPANT_KEY);
    if (existing && existing.length >= 8) return existing;
    const minted = mint();
    sessionStorage.setItem(PARTICIPANT_KEY, minted);
    return minted;
  } catch {
    // Private mode / storage disabled: an in-memory id for this page load.
    return mint();
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

/**
 * Remember which participant id owns the room, so the owner can come back to
 * it from another tab after closing the first one. This is not a transfer:
 * it only ever records the identity that created the room.
 */
export function storeHostParticipantId(roomId: string, participantId: string): void {
  try {
    localStorage.setItem(`${HOST_ID_PREFIX}${roomId}`, participantId);
  } catch {
    /* ignore */
  }
}

export function getHostParticipantId(roomId: string): string | null {
  try {
    return localStorage.getItem(`${HOST_ID_PREFIX}${roomId}`);
  } catch {
    return null;
  }
}

export function clearHostSecret(roomId: string): void {
  try {
    localStorage.removeItem(`${HOST_SECRET_PREFIX}${roomId}`);
    localStorage.removeItem(`${HOST_ID_PREFIX}${roomId}`);
  } catch {
    /* ignore */
  }
}

/** Drop the id format that was shared between tabs. */
export function forgetLegacyParticipantId(): void {
  try {
    if (localStorage.getItem(PARTICIPANT_KEY)) {
      localStorage.removeItem(PARTICIPANT_KEY);
    }
  } catch {
    /* ignore */
  }
}

export interface JoinIdentity {
  /** The participant id this tab should present. */
  participantId: string;
  /** Present only when this tab can prove it owns the room. */
  hostSecret: string | null;
  /** True when this tab is presenting the stored host identity. */
  claimingHostSeat: boolean;
}

/**
 * Work out which identity this tab should join with.
 *
 * @param roomId       the room being joined
 * @param hostConnected whether the host's seat is currently occupied
 */
export function resolveJoinIdentity(
  roomId: string,
  hostConnected: boolean,
): JoinIdentity {
  const ownId = getParticipantId();
  const secret = getHostSecret(roomId);
  const storedHostId = getHostParticipantId(roomId);

  if (!secret) return { participantId: ownId, hostSecret: null, claimingHostSeat: false };

  // This tab created the room (or was reloaded after doing so).
  if (!storedHostId || storedHostId === ownId) {
    return { participantId: ownId, hostSecret: secret, claimingHostSeat: true };
  }

  // Another window created it. If that window is still in the call, this tab is
  // an ordinary second participant; if the host seat is free, take it back so
  // the room does not become uncontrollable just because a tab was closed.
  if (hostConnected) {
    return { participantId: ownId, hostSecret: null, claimingHostSeat: false };
  }

  return { participantId: storedHostId, hostSecret: secret, claimingHostSeat: true };
}
