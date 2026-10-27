/**
 * Room-service tests: identity, capacity, ownership and host controls.
 *
 * These run the real service in `src/lib/rooms.ts` against in-memory stores, so
 * they exercise the same code the socket layer and the REST routes call. The
 * socket-level end-to-end behaviour lives in smoke.test.mjs.
 *
 * The behaviours pinned here are the ones that caused the reported bugs:
 *   - a reload must not consume a second seat  (ghost participants)
 *   - "room full" must never be caused by a ghost
 *   - capacity must be measured in connected participants
 *   - ownership must be proven, never inferred, and never transferred
 *   - a closed room and a removed participant must be refused permanently
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MemoryPresence,
  MemoryRoomStore,
  closeRoomByHost,
  closeRooms,
  createRoom,
  getRoom,
  initRooms,
  joinRoom,
  leaveRoom,
  purgeStaleParticipants,
  removeParticipantByHost,
  roomParticipants,
  verifyHost,
} from "../dist/test-entry.mjs";

const SECRET = "s".repeat(64);
const HOST = "p_host_000000001";
const GUEST_A = "p_guest_00000001";
const GUEST_B = "p_guest_00000002";
const GUEST_C = "p_guest_00000003";

/** A fresh service per test: no state can leak between them. */
async function freshService() {
  await closeRooms();
  await initRooms({ store: new MemoryRoomStore(), presence: new MemoryPresence() });
}

async function ownedRoom() {
  return createRoom({
    hostName: "Ada",
    hostParticipantId: HOST,
    hostSecret: SECRET,
  });
}

const join = (roomId, participantId, extra = {}) =>
  joinRoom(roomId, { participantId, socketId: extra.socketId ?? `sock-${participantId}`, ...extra });

beforeEach(freshService);
after(async () => {
  await closeRooms();
});

describe("ownership", () => {
  it("stores a hash of the host secret, never the secret itself", async () => {
    const room = await ownedRoom();

    assert.equal(room.hostParticipantId, HOST);
    assert.ok(room.hostSecretHash);
    assert.notEqual(room.hostSecretHash, SECRET, "the plaintext secret must not be stored");
    assert.equal(room.hostSecretHash.length, 64, "sha-256 hex digest");
    assert.equal(room.closedAt, null);
    assert.deepEqual(room.removedParticipantIds, []);
  });

  it("requires both the owner id and the secret to prove host identity", async () => {
    const room = await ownedRoom();

    assert.equal(verifyHost(room, HOST, SECRET), true);
    assert.equal(verifyHost(room, HOST, "wrong"), false, "id alone is not proof");
    assert.equal(verifyHost(room, HOST, undefined), false);
    assert.equal(verifyHost(room, GUEST_A, SECRET), false, "secret alone is not proof");
  });

  it("creates ownerless rooms when the client supplies no credentials", async () => {
    const room = await createRoom({ hostName: "Legacy" });
    assert.equal(room.hostParticipantId, null);
    assert.equal(room.hostSecretHash, null);
    // Nobody can claim it afterwards: there is no assignment path.
    assert.equal(verifyHost(room, HOST, SECRET), false);
  });

  it("never transfers ownership when the host disconnects for good", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A);

    // Host drops; the guest is now alone in the room.
    await leaveRoom(room.id, HOST, `sock-${HOST}`);
    await purgeStaleParticipants(room.id, -1);

    const stored = await getRoom(room.id);
    assert.equal(stored.hostParticipantId, HOST, "ownership is unchanged");

    // The remaining participant cannot take over, in any spelling of the call.
    assert.equal((await closeRoomByHost(room.id, GUEST_A, SECRET)).ok, false);
    assert.equal((await closeRoomByHost(room.id, GUEST_A, null)).ok, false);
    assert.equal(
      (await removeParticipantByHost(room.id, GUEST_A, SECRET, HOST)).ok,
      false,
    );
    assert.equal((await getRoom(room.id)).hostParticipantId, HOST);

    // And the real host is still the host when they come back.
    const back = await join(room.id, HOST, { hostSecret: SECRET });
    assert.equal(back.ok, true);
    assert.equal(back.isHost, true);
  });

  it("keeps ownership through a reload", async () => {
    const room = await ownedRoom();
    const first = await join(room.id, HOST, { hostSecret: SECRET });
    assert.equal(first.isHost, true);

    // Reload: the old socket dies, then the same browser joins again.
    await leaveRoom(room.id, HOST, `sock-${HOST}`);
    const again = await join(room.id, HOST, { hostSecret: SECRET, socketId: "sock-new" });

    assert.equal(again.ok, true);
    assert.equal(again.isHost, true);
    assert.equal(again.reclaimed, true, "the same seat, not a second one");
    assert.equal((await getRoom(room.id)).hostParticipantId, HOST);
  });

  it("refuses a host id presented without the secret", async () => {
    const room = await ownedRoom();
    const impostor = await joinRoom(room.id, {
      participantId: HOST,
      socketId: "sock-impostor",
      hostSecret: "not-the-secret",
    });

    assert.equal(impostor.ok, false);
    assert.equal(impostor.reason, "host-auth-failed");
    assert.equal((await roomParticipants(room.id)).length, 0, "no seat was taken");
  });
});

describe("joining and capacity", () => {
  it("lets two people in and refuses the third", async () => {
    const room = await ownedRoom();

    assert.equal((await join(room.id, HOST, { hostSecret: SECRET })).ok, true);
    assert.equal((await join(room.id, GUEST_A)).ok, true);

    const third = await join(room.id, GUEST_B);
    assert.equal(third.ok, false);
    assert.equal(third.reason, "full");
  });

  it("does not give a reloading participant a second seat", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A);

    // A reload lands as: disconnect, then join again with the same identity.
    await leaveRoom(room.id, GUEST_A, `sock-${GUEST_A}`);
    const reloaded = await join(room.id, GUEST_A, { socketId: "sock-after-reload" });

    assert.equal(reloaded.ok, true);
    assert.equal(reloaded.reclaimed, true);

    const seats = await roomParticipants(room.id);
    assert.equal(seats.length, 2, "still two people, not three");
    assert.equal(seats.filter((p) => p.socketId).length, 2);
  });

  it("does not let the same person join twice from two tabs", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET, socketId: "tab-one" });
    await join(room.id, HOST, { hostSecret: SECRET, socketId: "tab-two" });

    const seats = await roomParticipants(room.id);
    assert.equal(seats.length, 1);
    assert.equal(seats[0].socketId, "tab-two", "the newest socket holds the seat");
  });

  it("frees capacity as soon as someone disconnects, but keeps their seat", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A);

    // GUEST_A loses their connection: the seat is held for the grace period.
    await leaveRoom(room.id, GUEST_A, `sock-${GUEST_A}`);

    // Someone else can now take the free *slot*...
    assert.equal((await join(room.id, GUEST_B)).ok, true, "a dead seat must not block the room");

    // ...but the original participant cannot hold two seats when they return.
    const back = await join(room.id, GUEST_A, { socketId: "sock-guest-a-2" });
    assert.equal(back.ok, false);
    assert.equal(back.reason, "full");

    const connected = (await roomParticipants(room.id)).filter((p) => p.socketId);
    assert.equal(connected.length, 2, "never more than the limit");
  });

  it("purges seats abandoned past the grace period", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A);
    await leaveRoom(room.id, GUEST_A, `sock-${GUEST_A}`);

    const purged = await purgeStaleParticipants(room.id, -1);
    assert.equal(purged, 1);
    assert.deepEqual(
      (await roomParticipants(room.id)).map((p) => p.participantId),
      [HOST],
    );

    // The seat is gone, so a fresh join is a new participant, not a reclaim.
    const fresh = await join(room.id, GUEST_B);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.reclaimed, false);
  });

  it("keeps exactly two winners when three people join at once", async () => {
    const room = await ownedRoom();

    const results = await Promise.all([
      join(room.id, HOST, { hostSecret: SECRET }),
      join(room.id, GUEST_A),
      join(room.id, GUEST_B),
    ]);

    const accepted = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);

    assert.equal(accepted.length, 2, "capacity must hold under a simultaneous join");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, "full");

    const connected = (await roomParticipants(room.id)).filter((p) => p.socketId);
    assert.equal(connected.length, 2);
    assert.deepEqual(
      connected.map((p) => p.participantId).sort(),
      accepted.map((r) => r.participant.participantId).sort(),
      "the seats match the joins that were told yes",
    );
  });

  it("is not confused by a duplicate join on the same socket", async () => {
    const room = await ownedRoom();
    const first = await join(room.id, HOST, { hostSecret: SECRET, socketId: "one-socket" });
    const second = await join(room.id, HOST, { hostSecret: SECRET, socketId: "one-socket" });

    assert.equal(first.reclaimed, false);
    assert.equal(second.reclaimed, true);
    assert.equal((await roomParticipants(room.id)).length, 1);
  });

  it("refuses an anonymous or malformed participant id", async () => {
    const room = await ownedRoom();
    const missing = await joinRoom(room.id, { participantId: "", socketId: "x" });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "invalid-participant");

    const junk = await joinRoom(room.id, { participantId: "bad id with spaces", socketId: "x" });
    assert.equal(junk.ok, false);
    assert.equal(junk.reason, "invalid-participant");
  });
});

describe("host controls", () => {
  it("closes the room for everyone and refuses every later join", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A);

    const closed = await closeRoomByHost(room.id, HOST, SECRET);
    assert.deepEqual(closed, { ok: true });

    const guest = await join(room.id, GUEST_A, { socketId: "sock-again" });
    assert.equal(guest.ok, false);
    assert.equal(guest.reason, "closed", "a closed room refuses rejoiners");

    const host = await join(room.id, HOST, { hostSecret: SECRET, socketId: "sock-host-2" });
    assert.equal(host.ok, false);
    assert.equal(host.reason, "closed", "closed means closed, even for the host");

    assert.equal((await getRoom(room.id)).closedAt !== null, true);
    assert.equal((await roomParticipants(room.id)).length, 0, "presence is cleared on close");
  });

  it("cannot be closed twice", async () => {
    const room = await ownedRoom();
    await closeRoomByHost(room.id, HOST, SECRET);

    const again = await closeRoomByHost(room.id, HOST, SECRET);
    assert.equal(again.ok, false);
    assert.equal(again.reason, "already-closed");
  });

  it("refuses close from a guest, with and without a secret", async () => {
    const room = await ownedRoom();
    await join(room.id, GUEST_A);

    assert.equal((await closeRoomByHost(room.id, GUEST_A, SECRET)).reason, "not-host");
    assert.equal((await closeRoomByHost(room.id, GUEST_A, null)).reason, "not-host");
    assert.equal((await getRoom(room.id)).closedAt, null, "the room stays open");
  });

  it("removes a participant and refuses their rejoin for good", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A, { socketId: "sock-guest-a" });

    const removed = await removeParticipantByHost(room.id, HOST, SECRET, GUEST_A);
    assert.equal(removed.ok, true);
    assert.equal(removed.socketId, "sock-guest-a", "the caller can evict that socket");

    const rejoin = await join(room.id, GUEST_A, { socketId: "sock-guest-a-2" });
    assert.equal(rejoin.ok, false);
    assert.equal(rejoin.reason, "removed");

    // Even after the grace period, and even after a full reload.
    await purgeStaleParticipants(room.id, -1);
    const later = await join(room.id, GUEST_A, { socketId: "sock-guest-a-3" });
    assert.equal(later.ok, false);
    assert.equal(later.reason, "removed");
  });

  it("frees the removed participant's slot", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A);

    await removeParticipantByHost(room.id, HOST, SECRET, GUEST_A);
    assert.equal((await join(room.id, GUEST_B)).ok, true);
  });

  it("refuses removal from a guest, or of the host", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A);

    assert.equal(
      (await removeParticipantByHost(room.id, GUEST_A, SECRET, HOST)).reason,
      "not-host",
    );
    assert.equal(
      (await removeParticipantByHost(room.id, HOST, SECRET, HOST)).reason,
      "target-not-found",
      "the host cannot remove themselves — they end the call instead",
    );
    assert.equal(
      (await removeParticipantByHost(room.id, HOST, SECRET, GUEST_C)).reason,
      "target-not-found",
    );
  });

  it("cannot be replayed against a room that no longer exists", async () => {
    const room = await ownedRoom();
    assert.equal((await closeRoomByHost("nosuchroom12", HOST, SECRET)).reason, "not-found");
    assert.equal((await removeParticipantByHost(room.id, HOST, SECRET, GUEST_A)).reason, "target-not-found");
  });
});

describe("stale sockets", () => {
  it("ignores a late disconnect from a socket that was already replaced", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET, socketId: "sock-old" });

    // The reload already reconnected on a new socket.
    await join(room.id, HOST, { hostSecret: SECRET, socketId: "sock-new" });

    // The old socket is reaped afterwards and must not evict the new session.
    const changed = await leaveRoom(room.id, HOST, "sock-old");
    assert.equal(changed, false);
    assert.equal((await roomParticipants(room.id))[0].socketId, "sock-new");
    assert.equal((await roomParticipants(room.id)).filter((p) => p.socketId).length, 1);

    // The socket that owns the seat still releases it.
    assert.equal(await leaveRoom(room.id, HOST, "sock-new"), true);
    assert.equal((await roomParticipants(room.id)).filter((p) => p.socketId).length, 0);
  });

  it("treats an explicit leave as final", async () => {
    const room = await ownedRoom();
    await join(room.id, HOST, { hostSecret: SECRET });
    await join(room.id, GUEST_A);

    const { abandonRoom } = await import("../dist/test-entry.mjs");
    await abandonRoom(room.id, GUEST_A);
    assert.deepEqual(
      (await roomParticipants(room.id)).map((p) => p.participantId),
      [HOST],
      "leaving removes the record, so nothing holds the seat",
    );
    assert.equal((await join(room.id, GUEST_B)).ok, true);
  });
});
