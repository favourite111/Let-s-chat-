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
    socket.emit("join-room", "ghost-room-123");
    assert.equal((await receipt).reason, "room-not-found");
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
    assert.equal((await res.json()).participantCount, 1, "REST must reflect joined sockets");
  });

  it("drops the count when the peer leaves", async () => {
    const room = await createRoom();
    const socket = connect();
    await once(socket, "connect");
    socket.emit("join-room", room.id);
    await once(socket, "room-joined");
    socket.disconnect();
    await delay(400);

    const res = await fetch(`${BASE}/api/rooms/${room.id}`);
    assert.equal((await res.json()).participantCount, 0);
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
    socket.emit("join-room", busy.id);
    await once(socket, "room-joined");

    // Restart with a 1s TTL and a 300ms sweep interval so the sweeper runs
    // immediately rather than on its 5-minute default.
    sockets.forEach((s) => s.disconnect());
    await stopServer(child);
    child = await startServer({ ROOM_TTL_MS: "1000", ROOM_SWEEP_INTERVAL_MS: "300" });

    const holder = connect();
    await once(holder, "connect");
    holder.emit("join-room", busy.id);
    await once(holder, "room-joined");

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
