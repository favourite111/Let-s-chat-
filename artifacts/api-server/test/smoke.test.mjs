/**
 * Integration tests for the API + signaling server.
 *
 * Regression tests for the bugs found in the audit:
 *   - a null payload used to crash the process      (P0-1)
 *   - any string used to be a valid room            (P0-2)
 *   - participantCount was always 0                 (P1-7)
 *   - unknown /api routes returned the SPA HTML     (P2)
 *
 * Plus storage coverage:
 *   - rooms are written to SQLite and survive a restart
 *   - the sweeper reclaims empty rooms past the TTL
 *
 * Run with: pnpm --filter @workspace/api-server test
 * (Requires `pnpm --filter @workspace/api-server build` first.)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "index.mjs");
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;

const dataDir = mkdtempSync(path.join(tmpdir(), "videocall-test-"));
const sqlitePath = path.join(dataDir, "rooms.db");

let child = null;
const sockets = [];

function connect() {
  const socket = io(BASE, { path: "/socket.io", transports: ["websocket"], reconnection: false });
  sockets.push(socket);
  return socket;
}

/** Wait for an event whose payload satisfies `predicate` (later ones win). */
function onceWhere(socket, event, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for a matching "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      let matched = false;
      try {
        matched = predicate(payload);
      } catch {
        matched = false;
      }
      if (!matched) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function startServer(extraEnv = {}) {
  const proc = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      // Explicit and isolated: every test run gets its own database file.
      STORE: "sqlite",
      SQLITE_PATH: sqlitePath,
      ROOM_CREATE_LIMIT_PER_MINUTE: "10000",
      RATE_LIMIT_PER_MINUTE: "100000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/healthz`);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await delay(150);
  }
  throw new Error("Server did not start in time");
}

async function stopServer(proc) {
  if (!proc) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
  await delay(150);
}

let participantSeq = 0;
/** A fresh participant id in the shape the client mints. */
function newParticipantId(label = "peer") {
  participantSeq += 1;
  return `p_${label}_${String(participantSeq).padStart(6, "0")}`;
}

const HOST_SECRET = "test-host-secret-0123456789abcdef";

async function createRoom(hostName, owner = null) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostName,
      ...(owner ? { hostParticipantId: owner.participantId, hostSecret: owner.secret } : {}),
    }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

/** A room with a real owner, plus the credentials that owner would hold. */
async function createOwnedRoom(hostName = "Ada") {
  const owner = { participantId: newParticipantId("host"), secret: HOST_SECRET };
  const room = await createRoom(hostName, owner);
  return { room, owner };
}

/** Join with an identity, and wait for the server's verdict. */
async function joinRoom(socket, roomId, participantId, extra = {}) {
  const receipt = once(socket, "room-joined", 4000).catch((err) => ({ error: err }));
  socket.emit("join-room", { roomId, participantId, ...extra });
  const result = await receipt;
  if (result?.error) throw result.error;
  return result;
}

before(async () => {
  child = await startServer();
});

after(async () => {
  sockets.forEach((socket) => socket.disconnect());
  await stopServer(child);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("REST API", () => {
  it("reports health and the active store", async () => {
    const res = await fetch(`${BASE}/api/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptime, "number");
    assert.equal(typeof body.rooms, "number");
  });

  it("creates a room with a 60-bit id", async () => {
    const room = await createRoom("Ada");
    assert.match(room.id, /^[0-9a-hjkmnp-tv-z]{12}$/);
    assert.equal(room.participantCount, 0);
    assert.ok(Date.parse(room.createdAt));
  });

  it("rejects an invalid body and truncates a long host name", async () => {
    const bad = await fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostName: 123 }),
    });
    assert.equal(bad.status, 400);

    const tooLong = await fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostName: "x".repeat(500) }),
    });
    const room = await tooLong.json();
    assert.ok(room.hostName.length <= 64);
  });

  it("returns 404 for unknown rooms", async () => {
    const missing = await fetch(`${BASE}/api/rooms/doesnotexist`);
    assert.equal(missing.status, 404);
  });

  it("answers unknown /api routes with JSON, not HTML", async () => {
    const res = await fetch(`${BASE}/api/nope`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  it("serves ICE config", async () => {
    const res = await fetch(`${BASE}/api/ice`);
    const body = await res.json();
    assert.ok(Array.isArray(body.iceServers));
    assert.ok(body.iceServers.length >= 1);
  });
});

describe("Signaling", () => {
  it("rejects joining a room that was never created", async () => {
    const socket = connect();
    await once(socket, "connect");
    const receipt = once(socket, "join-error");
    socket.emit("join-room", { roomId: "ghost-room-123", participantId: newParticipantId() });
    assert.equal((await receipt).reason, "room-not-found");
  });

  it("requires a participant identity to join", async () => {
    const { room } = await createOwnedRoom();
    const socket = connect();
    await once(socket, "connect");

    const receipt = once(socket, "join-error");
    socket.emit("join-room", { roomId: room.id });
    assert.equal((await receipt).reason, "invalid-participant");

    // The bare-string form is still understood, but anonymous is not.
    const receipt2 = once(socket, "join-error");
    socket.emit("join-room", room.id);
    assert.equal((await receipt2).reason, "invalid-participant");
  });

  it("refuses a third participant", async () => {
    const { room } = await createOwnedRoom();
    const a = connect();
    const b = connect();
    const c = connect();
    await Promise.all([once(a, "connect"), once(b, "connect"), once(c, "connect")]);

    await joinRoom(a, room.id, newParticipantId("a"));
    await joinRoom(b, room.id, newParticipantId("b"));

    const full = once(c, "room-full");
    c.emit("join-room", { roomId: room.id, participantId: newParticipantId("c") });
    await full;
  });

  it("does not count a reload as a second participant", async () => {
    const { room, owner } = await createOwnedRoom();
    const host = owner.participantId;
    const guest = newParticipantId("guest");

    const a = connect();
    const b = connect();
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    await joinRoom(a, room.id, host, { hostSecret: owner.secret });
    await joinRoom(b, room.id, guest);

    // The guest reloads: a new socket arrives with the same participant id.
    b.disconnect();
    await delay(150);

    const b2 = connect();
    await once(b2, "connect");
    const reclaimed = once(b2, "room-joined");
    b2.emit("join-room", { roomId: room.id, participantId: guest });
    const joined = await reclaimed;
    assert.equal(joined.reclaimed, true, "the reload must reclaim the same seat");

    const res = await fetch(`${BASE}/api/rooms/${room.id}`);
    assert.equal((await res.json()).participantCount, 2, "still two people");

    // And a genuinely new person is still refused: the room is full of humans,
    // not of ghosts of the person who just reloaded.
    const c = connect();
    await once(c, "connect");
    const full = once(c, "room-full");
    c.emit("join-room", { roomId: room.id, participantId: newParticipantId("c") });
    await full;
  });

  it("lets two people join when one of them reloads mid-join", async () => {
    const { room, owner } = await createOwnedRoom();
    const host = owner.participantId;
    const guest = newParticipantId("guest");

    const a = connect();
    await once(a, "connect");
    await joinRoom(a, room.id, host, { hostSecret: owner.secret });

    // Guest's first socket dies immediately after (or during) its join.
    const b = connect();
    await once(b, "connect");
    b.emit("join-room", { roomId: room.id, participantId: guest });
    b.disconnect();

    const b2 = connect();
    await once(b2, "connect");
    const joined = await joinRoom(b2, room.id, guest);

    assert.equal(joined.participants.filter((p) => p.connected).length, 2);
    assert.equal(joined.isHost, false);

    // Both sides see each other.
    const roster = await onceWhere(b2, "room-state", (state) => state.count === 2);
    assert.equal(roster.count, 2);
  });

  it("keeps participantCount in sync with the socket layer", async () => {
    const { room } = await createOwnedRoom();
    const socket = connect();
    await once(socket, "connect");
    await joinRoom(socket, room.id, newParticipantId());

    const res = await fetch(`${BASE}/api/rooms/${room.id}`);
    assert.equal((await res.json()).participantCount, 1, "REST must reflect joined sockets");
  });

  it("drops the count when the peer leaves", async () => {
    const { room } = await createOwnedRoom();
    const socket = connect();
    await once(socket, "connect");
    await joinRoom(socket, room.id, newParticipantId());
    socket.disconnect();
    await delay(400);

    const res = await fetch(`${BASE}/api/rooms/${room.id}`);
    assert.equal((await res.json()).participantCount, 0);
  });

  it("broadcasts a roster the moment membership changes", async () => {
    const { room, owner } = await createOwnedRoom();
    const host = owner.participantId;
    const guest = newParticipantId("guest");

    const a = connect();
    await once(a, "connect");
    await joinRoom(a, room.id, host, { hostSecret: owner.secret, displayName: "Ada" });

    // Wait for the roster that actually contains both people: `room-state` is
    // also emitted for the host's own join, before this listener existed.
    const firstState = onceWhere(a, "room-state", (payload) => payload.count === 2);
    const b = connect();
    await once(b, "connect");
    await joinRoom(b, room.id, guest, { displayName: "Grace" });
    const state = await firstState;

    assert.equal(state.count, 2);
    const roles = Object.fromEntries(state.participants.map((p) => [p.participantId, p.role]));
    assert.equal(roles[host], "host");
    assert.equal(roles[guest], "guest");

    // And it goes back down when the guest drops.
    const dropped = onceWhere(a, "room-state", (payload) => payload.count === 1);
    b.disconnect();
    const after = await dropped;
    assert.equal(after.count, 1);
    assert.deepEqual(after.participants.map((p) => p.participantId), [host]);
  });

  it("relays offer/answer/ICE only inside a room, addressed by participant", async () => {
    const { room, owner } = await createOwnedRoom();
    const hostId = owner.participantId;
    const guestId = newParticipantId("guest");

    const a = connect();
    const b = connect();
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    await joinRoom(a, room.id, hostId, { hostSecret: owner.secret });

    const announced = once(a, "user-connected");
    await joinRoom(b, room.id, guestId);
    const announcement = await announced;
    assert.equal(announcement.participantId, guestId, "peers are announced by identity");

    const offerPromise = once(b, "offer");
    a.emit("offer", { offer: { type: "offer", sdp: "x" }, to: guestId });
    const offer = await offerPromise;
    assert.equal(offer.offer.sdp, "x");
    assert.equal(offer.from, hostId);

    const answerPromise = once(a, "answer");
    b.emit("answer", { answer: { type: "answer", sdp: "y" }, to: hostId });
    assert.equal((await answerPromise).from, guestId);

    const icePromise = once(b, "ice-candidate");
    a.emit("ice-candidate", { candidate: { candidate: "c" }, to: guestId });
    assert.equal((await icePromise).from, hostId);

    // An outsider may not use the server as a relay.
    const outsider = connect();
    await once(outsider, "connect");
    let leaked = false;
    b.once("offer", () => {
      leaked = true;
    });
    outsider.emit("offer", { offer: { type: "offer", sdp: "spoof" }, to: guestId });
    await delay(300);
    assert.equal(leaked, false, "cross-room relay must be dropped");
  });

  it("survives malformed payloads instead of crashing", async () => {
    const { room } = await createOwnedRoom();
    const socket = connect();
    await once(socket, "connect");
    await joinRoom(socket, room.id, newParticipantId());

    socket.emit("ice-candidate", null);
    socket.emit("offer", null);
    socket.emit("answer", null);
    socket.emit("ice-candidate", { to: null });
    socket.emit("offer", { offer: {}, to: { evil: true } });
    socket.emit("join-room", 12345);
    socket.emit("join-room", { $ne: null });
    socket.emit("media-state", null);
    socket.emit("remove-participant", null);
    socket.emit("remove-participant", { participantId: "../../etc/passwd" });
    socket.emit("end-call");
    socket.emit("ping");

    await delay(500);

    const res = await fetch(`${BASE}/api/healthz`);
    assert.equal(res.status, 200, "server must still be alive");
    assert.equal((await res.json()).status, "ok");
  });
});

describe("Host controls over the socket", () => {
  it("ends the call for everyone and closes the room", async () => {
    const { room, owner } = await createOwnedRoom();
    const guestId = newParticipantId("guest");

    const host = connect();
    const guest = connect();
    await Promise.all([once(host, "connect"), once(guest, "connect")]);
    await joinRoom(host, room.id, owner.participantId, { hostSecret: owner.secret });
    await joinRoom(guest, room.id, guestId);

    const hostClosed = once(host, "room-closed");
    const guestClosed = once(guest, "room-closed");
    host.emit("end-call");

    assert.equal((await hostClosed).reason, "host-ended-call");
    assert.equal((await guestClosed).reason, "host-ended-call", "everyone is told, not just the host");

    const detail = await (await fetch(`${BASE}/api/rooms/${room.id}`)).json();
    assert.equal(detail.closed, true);
    assert.equal(detail.participantCount, 0);

    // Nobody can get back in — including with a fresh socket and identity.
    const latecomer = connect();
    await once(latecomer, "connect");
    const refused = once(latecomer, "room-closed");
    latecomer.emit("join-room", { roomId: room.id, participantId: newParticipantId("late") });
    await refused;

    // And the REST close route agrees with the socket.
    const res = await fetch(`${BASE}/api/rooms/${room.id}`, {
      method: "DELETE",
      headers: {
        "x-participant-id": owner.participantId,
        "x-host-secret": owner.secret,
      },
    });
    assert.equal(res.status, 409, "already closed");
  });

  it("refuses end-call from a participant", async () => {
    const { room, owner } = await createOwnedRoom();
    const guestId = newParticipantId("guest");

    const host = connect();
    const guest = connect();
    await Promise.all([once(host, "connect"), once(guest, "connect")]);
    await joinRoom(host, room.id, owner.participantId, { hostSecret: owner.secret });
    await joinRoom(guest, room.id, guestId);

    const refused = once(guest, "host-action-error");
    guest.emit("end-call");
    const error = await refused;
    assert.equal(error.action, "end-call");
    assert.equal(error.reason, "not-host");

    const detail = await (await fetch(`${BASE}/api/rooms/${room.id}`)).json();
    assert.equal(detail.closed, false, "a guest cannot close the room");
  });

  it("removes a participant, evicts them and refuses their rejoin", async () => {
    const { room, owner } = await createOwnedRoom();
    const guestId = newParticipantId("guest");

    const host = connect();
    const guest = connect();
    await Promise.all([once(host, "connect"), once(guest, "connect")]);
    await joinRoom(host, room.id, owner.participantId, { hostSecret: owner.secret });
    await joinRoom(guest, room.id, guestId);

    const evicted = once(guest, "removed");
    const confirmed = once(host, "participant-removed");
    host.emit("remove-participant", { participantId: guestId });

    assert.equal((await evicted).reason, "removed-by-host");
    assert.equal((await confirmed).participantId, guestId);

    // The evicted person's socket is gone.
    await delay(200);
    assert.equal(guest.connected, false, "the removed socket is disconnected server-side");

    // A brand new socket with the same identity is refused, permanently.
    const sneaky = connect();
    await once(sneaky, "connect");
    const refused = once(sneaky, "removed");
    sneaky.emit("join-room", { roomId: room.id, participantId: guestId });
    await refused;

    // The freed slot is usable by someone else.
    const replacement = connect();
    await once(replacement, "connect");
    const joined = await joinRoom(replacement, room.id, newParticipantId("other"));
    assert.equal(joined.participants.filter((p) => p.connected).length, 2);
  });

  it("refuses removal from a participant", async () => {
    const { room, owner } = await createOwnedRoom();
    const guestId = newParticipantId("guest");

    const host = connect();
    const guest = connect();
    await Promise.all([once(host, "connect"), once(guest, "connect")]);
    await joinRoom(host, room.id, owner.participantId, { hostSecret: owner.secret });
    await joinRoom(guest, room.id, guestId);

    const refused = once(guest, "host-action-error");
    guest.emit("remove-participant", { participantId: owner.participantId });
    const error = await refused;
    assert.equal(error.action, "remove-participant");
    assert.equal(error.reason, "not-host");

    // The host is still there.
    const detail = await (await fetch(`${BASE}/api/rooms/${room.id}`)).json();
    assert.equal(detail.participantCount, 2);
  });

  it("keeps the host's ownership through a reconnect", async () => {
    const { room, owner } = await createOwnedRoom();
    const guestId = newParticipantId("guest");

    const hostSocket = connect();
    const guest = connect();
    await Promise.all([once(hostSocket, "connect"), once(guest, "connect")]);
    const first = await joinRoom(hostSocket, room.id, owner.participantId, {
      hostSecret: owner.secret,
    });
    assert.equal(first.isHost, true);
    await joinRoom(guest, room.id, guestId);

    // Host's connection drops, then returns on a new socket.
    hostSocket.disconnect();
    await delay(300);

    const hostAgain = connect();
    await once(hostAgain, "connect");
    const rejoined = await joinRoom(hostAgain, room.id, owner.participantId, {
      hostSecret: owner.secret,
    });
    assert.equal(rejoined.isHost, true, "ownership survives the reconnect");
    assert.equal(rejoined.reclaimed, true);

    // Still able to close: the powers came back with the identity.
    const closed = once(guest, "room-closed");
    hostAgain.emit("end-call");
    await closed;
  });

  it("does not let the remaining participant become host when the host is gone", async () => {
    const { room, owner } = await createOwnedRoom();
    const guestId = newParticipantId("guest");

    const hostSocket = connect();
    const guest = connect();
    await Promise.all([once(hostSocket, "connect"), once(guest, "connect")]);
    await joinRoom(hostSocket, room.id, owner.participantId, { hostSecret: owner.secret });
    await joinRoom(guest, room.id, guestId);

    hostSocket.disconnect();
    await delay(400);

    const refused = once(guest, "host-action-error");
    guest.emit("end-call");
    assert.equal((await refused).reason, "not-host");

    // The room is still the original host's, and still open.
    const detail = await (await fetch(`${BASE}/api/rooms/${room.id}`)).json();
    assert.equal(detail.closed, false);
    assert.equal(detail.participantCount, 1);

    // If they pretend to be the host by reusing the id, the secret is not there.
    const impostor = connect();
    await once(impostor, "connect");
    const rejected = once(impostor, "join-error");
    impostor.emit("join-room", { roomId: room.id, participantId: owner.participantId });
    assert.equal((await rejected).reason, "host-auth-failed");
  });
});

describe("REST host authorization", () => {
  it("refuses an unauthenticated close", async () => {
    const { room } = await createOwnedRoom();

    const anonymous = await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE" });
    assert.equal(anonymous.status, 403);

    const withIdOnly = await fetch(`${BASE}/api/rooms/${room.id}`, {
      method: "DELETE",
      headers: { "x-participant-id": "p_someone_00001" },
    });
    assert.equal(withIdOnly.status, 403);

    const wrongSecret = await fetch(`${BASE}/api/rooms/${room.id}`, {
      method: "DELETE",
      headers: {
        "x-participant-id": room.hostName === "Ada" ? "p_wrong_00000001" : "x",
        "x-host-secret": "guess",
      },
    });
    assert.equal(wrongSecret.status, 403);

    const detail = await (await fetch(`${BASE}/api/rooms/${room.id}`)).json();
    assert.equal(detail.closed, false, "nothing closed the room");
  });

  it("closes the room for the host and tells the people inside", async () => {
    const { room, owner } = await createOwnedRoom();

    const guest = connect();
    await once(guest, "connect");
    await joinRoom(guest, room.id, newParticipantId("guest"));

    const notified = once(guest, "room-closed");
    const res = await fetch(`${BASE}/api/rooms/${room.id}`, {
      method: "DELETE",
      headers: {
        "x-participant-id": owner.participantId,
        "x-host-secret": owner.secret,
      },
    });
    assert.equal(res.status, 204);
    assert.equal((await notified).reason, "host-ended-call");

    const detail = await (await fetch(`${BASE}/api/rooms/${room.id}`)).json();
    assert.equal(detail.closed, true);
  });
});

describe("Durability (SQLite)", () => {
  it("writes rooms to a real database file", async () => {
    await createRoom("Disk");
    await delay(100);
    assert.ok(existsSync(sqlitePath), "expected the sqlite file to exist");
    assert.ok(statSync(sqlitePath).size > 0);
  });

  it("keeps rooms across a full server restart", async () => {
    const room = await createRoom("Survivor");

    sockets.forEach((socket) => socket.disconnect());
    await stopServer(child);

    child = await startServer();

    const res = await fetch(`${BASE}/api/rooms/${room.id}`);
    assert.equal(res.status, 200, "room must still exist after a restart");
    const body = await res.json();
    assert.equal(body.id, room.id);
    assert.equal(body.hostName, "Survivor");
    // Presence is ephemeral by design: nobody is in the call after a restart.
    assert.equal(body.participantCount, 0);
  });

  it("sweeps empty rooms past the TTL but keeps occupied ones", async () => {
    const idle = await createRoom("Idle");
    const busy = await createRoom("Busy");

    // Rewind the idle room so it looks hours old.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(sqlitePath);
    db.prepare("UPDATE rooms SET last_seen_at = ? WHERE id = ?").run(
      Date.now() - 7 * 60 * 60 * 1000,
      idle.id,
    );
    db.close();

    // Keep somebody inside the other room.
    const socket = connect();
    await once(socket, "connect");
    await joinRoom(socket, busy.id, newParticipantId("busy"));

    // Restart with a 1s TTL and a 300ms sweep interval so the sweeper runs
    // immediately rather than on its 5-minute default.
    sockets.forEach((s) => s.disconnect());
    await stopServer(child);
    child = await startServer({ ROOM_TTL_MS: "1000", ROOM_SWEEP_INTERVAL_MS: "300" });

    const holder = connect();
    await once(holder, "connect");
    await joinRoom(holder, busy.id, newParticipantId("holder"));

    await delay(1200);

    assert.equal(
      (await fetch(`${BASE}/api/rooms/${idle.id}`)).status,
      404,
      "idle empty room should be swept",
    );
    assert.equal(
      (await fetch(`${BASE}/api/rooms/${busy.id}`)).status,
      200,
      "occupied room must never be swept",
    );
  });
});
