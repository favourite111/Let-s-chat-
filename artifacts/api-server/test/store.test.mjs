/**
 * Storage-backend tests.
 *
 * Everything here runs through the real compiled sources (dist/test-entry.mjs):
 *
 *   - SQLite  → a real database file in a temp dir
 *   - Postgres→ pg-mem, a real SQL engine speaking the Postgres dialect, so the
 *               actual SQL in PostgresRoomStore is exercised with no server
 *   - Redis   → a minimal stand-in implementing the set commands we use
 *
 * GitHub Actions also runs the full API suite against real Postgres and Redis
 * service containers (see .github/workflows/ci.yml).
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
    assert.equal(await store.count(), 1);

    await store.touch("memroom00001", 42);
    assert.equal((await store.get("memroom00001")).lastSeenAt, 42);
    assert.deepEqual(await store.listOlderThan(100), ["memroom00001"]);

    assert.equal(await store.remove("memroom00001"), true);
    assert.equal(await store.get("memroom00001"), undefined);
    assert.equal(await store.count(), 0);
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
    assert.equal(await second.count(), 1);

    assert.deepEqual(await second.listOlderThan(Date.now()), ["sqliteroom01"]);
    assert.deepEqual(await second.listOlderThan(1), []);

    assert.equal(await second.remove("sqliteroom01"), true);
    assert.equal(await second.count(), 0);
    await second.close();
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

  it("init is idempotent (CREATE TABLE IF NOT EXISTS)", async () => {
    const { newDb } = await import("pg-mem");
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();

    const a = new PostgresRoomStore("postgres://unused", () => pool);
    await a.init();
    const b = new PostgresRoomStore("postgres://unused", () => pool);
    await b.init();

    await b.insert(sampleRoom("pgroom000002"));
    assert.equal(await b.count(), 1);
  });
});

describe("MemoryPresence", () => {
  it("counts unique sockets and evicts on leave", async () => {
    const presence = new MemoryPresence();

    assert.equal(await presence.add("room", "socket-a"), 1);
    assert.equal(await presence.add("room", "socket-b"), 2);
    assert.equal(await presence.add("room", "socket-a"), 2, "double add must not double count");
    assert.deepEqual((await presence.peers("room")).sort(), ["socket-a", "socket-b"]);

    assert.equal(await presence.remove("room", "socket-a"), 1);
    assert.equal(await presence.count("room"), 1);

    await presence.clear("room");
    assert.equal(await presence.count("room"), 0);
    assert.deepEqual(await presence.peers("room"), []);
  });
});

describe("RedisPresence", () => {
  const makeFakeClient = () => {
    const sets = new Map();
    return {
      handled: sets,
      on() {},
      async connect() {},
      async sAdd(key, value) {
        if (!sets.has(key)) sets.set(key, new Set());
        const added = !sets.get(key).has(value);
        sets.get(key).add(value);
        return added ? 1 : 0;
      },
      async sRem(key, value) {
        const had = sets.get(key)?.delete(value) ?? false;
        return had ? 1 : 0;
      },
      async sCard(key) {
        return sets.get(key)?.size ?? 0;
      },
      async sMembers(key) {
        return [...(sets.get(key) ?? [])];
      },
      async expire() {
        return 1;
      },
      async del(key) {
        return sets.delete(key) ? 1 : 0;
      },
      async quit() {
        return "OK";
      },
    };
  };

  it("maps presence onto Redis sets", async () => {
    const client = makeFakeClient();
    const presence = new RedisPresence("redis://unused", () => client);
    await presence.init();

    assert.equal(await presence.add("room", "socket-a"), 1);
    assert.equal(await presence.add("room", "socket-b"), 2);
    assert.deepEqual((await presence.peers("room")).sort(), ["socket-a", "socket-b"]);

    assert.equal(await presence.remove("room", "socket-a"), 1);
    assert.equal(await presence.count("room"), 1);

    await presence.clear("room");
    assert.equal(await presence.count("room"), 0);
    assert.equal(client.handled.size, 0, "empty room keys are deleted, not left behind");
    await presence.close();
  });

  it("namespaces keys per room", async () => {
    const client = makeFakeClient();
    const presence = new RedisPresence("redis://unused", () => client);
    await presence.init();

    await presence.add("room-one", "socket-a");
    await presence.add("room-two", "socket-b");

    assert.deepEqual([...client.handled.keys()].sort(), [
      "videocall:peers:room-one",
      "videocall:peers:room-two",
    ]);
  });
});
