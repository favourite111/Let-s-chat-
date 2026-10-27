/**
 * Storage-backend tests.
 *
 * Everything here runs through the real compiled sources (dist/test-entry.mjs):
 *
 *   - SQLite  → a real database file in a temp dir
 *   - Postgres→ pg-mem, a real SQL engine speaking the Postgres dialect, so the
 *               actual SQL in PostgresRoomStore is exercised with no server
 *   - Redis   → a minimal stand-in implementing the hash commands we use
 *
 * GitHub Actions also runs the full API suite against real Postgres and Redis
 * service containers (see .github/ci.yml.example).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MemoryRoomStore,
  SqliteRoomStore,
  PostgresRoomStore,
  MemoryPresence,
  RedisPresence,
} from "../dist/test-entry.mjs";

const sampleRoom = (id) => ({
  id,
  hostName: "Ada",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  lastSeenAt: 1_700_000_000_000,
  hostParticipantId: "p_host_participant_1",
  hostSecretHash: "a".repeat(64),
  closedAt: null,
  removedParticipantIds: [],
});

const sampleParticipant = (participantId, socketId, extra = {}) => ({
  participantId,
  socketId,
  role: "guest",
  displayName: null,
  joinedAt: 1_000,
  connectedAt: 1_000,
  disconnectedAt: null,
  ...extra,
});

let dataDir;
before(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "videocall-store-"));
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

describe("MemoryRoomStore", () => {
  it("round-trips, touches and removes rooms", async () => {
    const store = new MemoryRoomStore();
    await store.init();

    await store.insert(sampleRoom("memroom00001"));
    const room = await store.get("memroom00001");
    assert.equal(room.hostName, "Ada");
    assert.equal(room.hostParticipantId, "p_host_participant_1");
    assert.equal(room.closedAt, null);
    assert.deepEqual(room.removedParticipantIds, []);
    assert.equal(await store.count(), 1);

    await store.touch("memroom00001", 42);
    assert.equal((await store.get("memroom00001")).lastSeenAt, 42);
    assert.deepEqual(await store.listOlderThan(100), ["memroom00001"]);

    assert.equal(await store.remove("memroom00001"), true);
    assert.equal(await store.get("memroom00001"), undefined);
    assert.equal(await store.count(), 0);
  });

  it("closes a room and remembers removed participants", async () => {
    const store = new MemoryRoomStore();
    await store.insert(sampleRoom("memroom00002"));

    await store.addRemoved("memroom00002", "p_guest_one");
    await store.addRemoved("memroom00002", "p_guest_two");
    // Re-adding must not duplicate.
    await store.addRemoved("memroom00002", "p_guest_one");
    assert.deepEqual((await store.get("memroom00002")).removedParticipantIds.sort(), [
      "p_guest_one",
      "p_guest_two",
    ]);

    await store.setClosed("memroom00002", 12345);
    assert.equal((await store.get("memroom00002")).closedAt, 12345);

    // Closing is not deleting: the record stays so joins can be refused.
    assert.equal(await store.count(), 1);
  });
});

describe("SqliteRoomStore", () => {
  it("persists to a real file and survives a reopen", async () => {
    const file = path.join(dataDir, "rooms.db");

    const first = new SqliteRoomStore(file);
    await first.init();
    await first.insert(sampleRoom("sqliteroom01"));
    await first.touch("sqliteroom01", 555);
    await first.close();

    assert.ok(existsSync(file), "database file should exist on disk");

    // A brand new instance against the same file = what a restart does.
    const second = new SqliteRoomStore(file);
    await second.init();
    const room = await second.get("sqliteroom01");
    assert.equal(room.hostName, "Ada");
    assert.equal(room.lastSeenAt, 555);
    assert.equal(room.hostParticipantId, "p_host_participant_1");
    assert.equal(await second.count(), 1);

    assert.deepEqual(await second.listOlderThan(Date.now()), ["sqliteroom01"]);
    assert.deepEqual(await second.listOlderThan(1), []);

    assert.equal(await second.remove("sqliteroom01"), true);
    assert.equal(await second.count(), 0);
    await second.close();
  });

  it("persists closure and removals to disk", async () => {
    const file = path.join(dataDir, "owned.db");
    const first = new SqliteRoomStore(file);
    await first.init();
    await first.insert(sampleRoom("sqliteroom03"));
    await first.setClosed("sqliteroom03", 999);
    await first.addRemoved("sqliteroom03", "p_guest_one");
    await first.close();

    const second = new SqliteRoomStore(file);
    await second.init();
    const room = await second.get("sqliteroom03");
    assert.equal(room.closedAt, 999, "a closed room must stay closed after a restart");
    assert.deepEqual(room.removedParticipantIds, ["p_guest_one"]);
    await second.close();
  });

  it("migrates a database created before ownership existed", async () => {
    const file = path.join(dataDir, "legacy.db");

    // The pre-ownership schema, exactly as it exists on the live deployment.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(file);
    db.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        host_name TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      INSERT INTO rooms (id, host_name, created_at, last_seen_at)
      VALUES ('legacyroom01', 'Old', 1, 2);
    `);
    db.close();

    const store = new SqliteRoomStore(file);
    await store.init();

    const room = await store.get("legacyroom01");
    assert.equal(room.hostName, "Old");
    // No owner, and none can ever be assigned — ownership is creation-only.
    assert.equal(room.hostParticipantId, null);
    assert.equal(room.hostSecretHash, null);
    assert.equal(room.closedAt, null);
    assert.deepEqual(room.removedParticipantIds, []);

    // The new columns are usable through the same store.
    await store.setClosed("legacyroom01", 7);
    assert.equal((await store.get("legacyroom01")).closedAt, 7);
    await store.close();
  });

  it("creates the parent directory when it does not exist", async () => {
    const file = path.join(dataDir, "nested", "deeper", "rooms.db");
    const store = new SqliteRoomStore(file);
    await store.init();
    await store.insert(sampleRoom("sqliteroom02"));
    assert.equal(await store.count(), 1);
    await store.close();
    assert.ok(existsSync(file));
  });
});

describe("PostgresRoomStore (pg-mem)", () => {
  const makeStore = async () => {
    const { newDb } = await import("pg-mem");
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const store = new PostgresRoomStore("postgres://unused", () => new Pool());
    await store.init();
    return store;
  };

  it("round-trips, touches, lists and removes rooms", async () => {
    const store = await makeStore();

    await store.insert(sampleRoom("pgroom000001"));
    const room = await store.get("pgroom000001");
    assert.equal(room.id, "pgroom000001");
    assert.equal(room.hostName, "Ada");
    assert.ok(room.createdAt instanceof Date);
    assert.equal(await store.count(), 1);

    await store.touch("pgroom000001", 777);
    assert.equal((await store.get("pgroom000001")).lastSeenAt, 777);

    assert.deepEqual(await store.listOlderThan(1000), ["pgroom000001"]);
    assert.deepEqual(await store.listOlderThan(1), []);

    assert.equal(await store.remove("pgroom000001"), true);
    assert.equal(await store.count(), 0);
    assert.equal(await store.remove("pgroom000001"), false);
    await store.close();
  });

  it("stores ownership, closure and removals", async () => {
    const store = await makeStore();

    await store.insert(sampleRoom("pgroom000003"));
    await store.addRemoved("pgroom000003", "p_guest_one");
    await store.setClosed("pgroom000003", 4242);

    const room = await store.get("pgroom000003");
    assert.equal(room.hostParticipantId, "p_host_participant_1");
    assert.equal(room.closedAt, 4242);
    assert.deepEqual(room.removedParticipantIds, ["p_guest_one"]);
    await store.close();
  });

  it(
    "init is idempotent against a real database",
    { skip: !process.env.DATABASE_URL && "needs DATABASE_URL (pg-mem cannot re-run CREATE TABLE IF NOT EXISTS)" },
    async () => {
      // Exercised in CI against the real Postgres service container: booting
      // the server twice must not fail because the table already exists.
      const a = new PostgresRoomStore(process.env.DATABASE_URL);
      await a.init();
      const b = new PostgresRoomStore(process.env.DATABASE_URL);
      await b.init();

      await b.insert(sampleRoom("pgroom000002"));
      assert.equal(await b.count() >= 1, true);
      await b.remove("pgroom000002");
      await a.close();
    },
  );
});

describe("MemoryPresence", () => {
  it("keys seats by participant, not socket", async () => {
    const presence = new MemoryPresence();

    await presence.upsert("room", sampleParticipant("p_a", "socket-a"));
    await presence.upsert("room", sampleParticipant("p_b", "socket-b"));

    assert.equal(await presence.countConnected("room"), 2);
    assert.equal((await presence.get("room", "p_a")).socketId, "socket-a");

    // A second join from the same person is a reclaim, never a second seat.
    await presence.upsert("room", sampleParticipant("p_a", "socket-a2"));
    assert.equal(await presence.countConnected("room"), 2);
    assert.equal((await presence.get("room", "p_a")).socketId, "socket-a2");

    await presence.remove("room", "p_a");
    assert.equal(await presence.countConnected("room"), 1);
    assert.deepEqual((await presence.list("room")).map((p) => p.participantId), ["p_b"]);

    await presence.clear("room");
    assert.equal(await presence.list("room").then((l) => l.length), 0);
  });

  it("stops counting a disconnected seat but keeps the record", async () => {
    const presence = new MemoryPresence();
    await presence.upsert("room", sampleParticipant("p_a", "socket-a"));

    assert.equal(await presence.markDisconnected("room", "p_a", 5_000), true);
    assert.equal(await presence.countConnected("room"), 0, "capacity frees immediately");

    const record = await presence.get("room", "p_a");
    assert.equal(record.socketId, null);
    assert.equal(record.disconnectedAt, 5_000);
    assert.equal(record.participantId, "p_a", "the seat survives for a reconnect");
  });

  it("ignores a stale socket dying after the seat was reclaimed", async () => {
    const presence = new MemoryPresence();
    await presence.upsert("room", sampleParticipant("p_a", "old-socket"));
    // The person reconnects before their old socket is reaped.
    await presence.upsert("room", sampleParticipant("p_a", "new-socket"));

    const changed = await presence.markDisconnected("room", "p_a", 9_000, "old-socket");
    assert.equal(changed, false, "the old socket must not clear the live session");
    assert.equal((await presence.get("room", "p_a")).socketId, "new-socket");
    assert.equal(await presence.countConnected("room"), 1);

    // The socket that actually holds the seat can still release it.
    assert.equal(await presence.markDisconnected("room", "p_a", 9_500, "new-socket"), true);
    assert.equal(await presence.countConnected("room"), 0);
  });
});

describe("RedisPresence", () => {
  const makeFakeClient = () => {
    const hashes = new Map();
    return {
      hashes,
      on() {},
      async connect() {},
      async hSet(key, field, value) {
        if (!hashes.has(key)) hashes.set(key, new Map());
        const added = !hashes.get(key).has(field);
        hashes.get(key).set(field, value);
        return added ? 1 : 0;
      },
      async hGet(key, field) {
        return hashes.get(key)?.get(field) ?? null;
      },
      async hDel(key, field) {
        return hashes.get(key)?.delete(field) ? 1 : 0;
      },
      async hGetAll(key) {
        const hash = hashes.get(key);
        return hash ? Object.fromEntries(hash) : {};
      },
      async hLen(key) {
        return hashes.get(key)?.size ?? 0;
      },
      async expire() {
        return 1;
      },
      async del(key) {
        return hashes.delete(key) ? 1 : 0;
      },
      async quit() {
        return "OK";
      },
    };
  };

  it("maps presence onto a Redis hash per room", async () => {
    const client = makeFakeClient();
    const presence = new RedisPresence("redis://unused", () => client);
    await presence.init();

    await presence.upsert("room", sampleParticipant("p_a", "socket-a"));
    await presence.upsert("room", sampleParticipant("p_b", "socket-b"));
    assert.equal(await presence.countConnected("room"), 2);

    // Reclaiming replaces the field instead of adding one.
    await presence.upsert("room", sampleParticipant("p_a", "socket-a2"));
    assert.equal(await presence.countConnected("room"), 2);
    assert.equal((await presence.get("room", "p_a")).socketId, "socket-a2");

    await presence.remove("room", "p_a");
    assert.equal(await presence.countConnected("room"), 1);

    await presence.clear("room");
    assert.equal(await presence.list("room").then((l) => l.length), 0);
    assert.equal(client.hashes.size, 0, "empty room keys are deleted, not left behind");
    await presence.close();
  });

  it("guards against a stale socket clearing a reclaimed seat", async () => {
    const client = makeFakeClient();
    const presence = new RedisPresence("redis://unused", () => client);
    await presence.init();

    await presence.upsert("room", sampleParticipant("p_a", "old-socket"));
    await presence.upsert("room", sampleParticipant("p_a", "new-socket"));

    assert.equal(await presence.markDisconnected("room", "p_a", 1, "old-socket"), false);
    assert.equal((await presence.get("room", "p_a")).socketId, "new-socket");
    assert.equal(await presence.countConnected("room"), 1);
    await presence.close();
  });

  it("namespaces keys per room", async () => {
    const client = makeFakeClient();
    const presence = new RedisPresence("redis://unused", () => client);
    await presence.init();

    await presence.upsert("room-one", sampleParticipant("p_a", "socket-a"));
    await presence.upsert("room-two", sampleParticipant("p_b", "socket-b"));

    assert.deepEqual([...client.hashes.keys()].sort(), [
      "videocall:participants:room-one",
      "videocall:participants:room-two",
    ]);
    await presence.close();
  });
});
