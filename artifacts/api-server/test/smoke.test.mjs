/**
 * Integration tests for the API + signaling server.
 *
 * These are regression tests for the bugs found in the audit:
 *   - a null payload used to crash the process  (P0-1)
 *   - any string used to be a valid room        (P0-2)
 *   - participantCount was always 0             (P1-7)
 *   - unknown /api routes returned the SPA HTML (P2)
 *
 * Run with: pnpm --filter @workspace/api-server test
 * (Requires `pnpm --filter @workspace/api-server build` first.)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { io } from "socket.io-client";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "index.mjs");
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
const sockets = [];

function connect() {
  const socket = io(BASE, { path: "/socket.io", transports: ["websocket"], reconnection: false });
  sockets.push(socket);
  return socket;
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

async function createRoom(hostName) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostName }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

before(async () => {
  child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      // Keep the limiter out of the way for room-creation tests.
      ROOM_CREATE_LIMIT_PER_MINUTE: "10000",
      RATE_LIMIT_PER_MINUTE: "100000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(200);
  }
  throw new Error("Server did not start in time");
});

after(async () => {
  sockets.forEach((socket) => socket.disconnect());
  child?.kill("SIGTERM");
  await delay(300);
  child?.kill("SIGKILL");
});

describe("REST API", () => {
  it("reports health", async () => {
    const res = await fetch(`${BASE}/api/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptime, "number");
  });

  it("creates a room with a 60-bit id", async () => {
    const room = await createRoom("Ada");
    assert.match(room.id, /^[0-9a-hjkmnp-tv-z]{12}$/);
    assert.equal(room.participantCount, 0);
    assert.ok(Date.parse(room.createdAt));
  });

  it("returns 404 for an unknown room and 400 for an invalid body", async () => {
    const missing = await fetch(`${BASE}/api/rooms/doesnotexist`);
    assert.equal(missing.status, 404);

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
    const longRoom = await tooLong.json();
    assert.ok(longRoom.hostName.length <= 64);
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
    socket.emit("join-room", "ghost-room-123");
    const payload = await receipt;
    assert.equal(payload.reason, "room-not-found");
  });

  it("refuses a third participant", async () => {
    const room = await createRoom();
    const a = connect();
    const b = connect();
    const c = connect();
    await Promise.all([once(a, "connect"), once(b, "connect"), once(c, "connect")]);

    a.emit("join-room", room.id);
    await once(a, "room-joined");
    b.emit("join-room", room.id);
    await once(b, "room-joined");

    const full = once(c, "room-full");
    c.emit("join-room", room.id);
    await full;
  });

  it("keeps participantCount in sync with the socket layer", async () => {
    const room = await createRoom();
    const socket = connect();
    await once(socket, "connect");
    socket.emit("join-room", room.id);
    await once(socket, "room-joined");

    const res = await fetch(`${BASE}/api/rooms/${room.id}`);
    const body = await res.json();
    assert.equal(body.participantCount, 1, "REST must reflect joined sockets");
  });

  it("relays offer/answer/ICE only inside a room", async () => {
    const room = await createRoom();
    const a = connect();
    const b = connect();
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    a.emit("join-room", room.id);
    await once(a, "room-joined");
    const announced = once(a, "user-connected");
    b.emit("join-room", room.id);
    const peerId = await announced;

    const offerPromise = once(b, "offer");
    a.emit("offer", { offer: { type: "offer", sdp: "x" }, to: peerId });
    const offer = await offerPromise;
    assert.equal(offer.offer.sdp, "x");
    assert.equal(offer.from, a.id);

    // A socket outside the room cannot use the relay.
    const outsider = connect();
    await once(outsider, "connect");
    let leaked = false;
    b.once("offer", () => {
      leaked = true;
    });
    outsider.emit("offer", { offer: { type: "offer", sdp: "spoof" }, to: b.id });
    await delay(300);
    assert.equal(leaked, false, "cross-room relay must be dropped");
  });

  it("survives malformed payloads instead of crashing", async () => {
    const room = await createRoom();
    const socket = connect();
    await once(socket, "connect");
    socket.emit("join-room", room.id);
    await once(socket, "room-joined");

    // Every one of these used to be able to kill the process.
    socket.emit("ice-candidate", null);
    socket.emit("offer", null);
    socket.emit("answer", null);
    socket.emit("ice-candidate", { to: null });
    socket.emit("offer", { offer: {}, to: { evil: true } });
    socket.emit("join-room", 12345);
    socket.emit("join-room", { $ne: null });
    socket.emit("media-state", null);
    socket.emit("ping");

    await delay(500);

    const res = await fetch(`${BASE}/api/healthz`);
    assert.equal(res.status, 200, "server must still be alive");
    assert.equal((await res.json()).status, "ok");
  });
});
