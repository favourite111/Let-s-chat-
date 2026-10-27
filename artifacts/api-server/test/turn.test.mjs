/**
 * TURN credential tests.
 *
 * These pin the credential format to coturn's "TURN REST API" scheme:
 *
 *     username   = "<unix-expiry>:<label>"
 *     credential = base64(HMAC-SHA1(secret, username))
 *
 * Verified against a real coturn 4.6.1 with `use-auth-secret`: credentials
 * minted here complete an allocation and relay traffic, while a wrong secret
 * or an expired username is rejected. If this formula ever drifts, calls stop
 * relaying on exactly the networks that need it most.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  cloudflareSettingsFromEnv,
  deriveTurnCredential,
  fetchCloudflareIceServers,
  mintTurnCredentials,
  resetCloudflareCache,
  turnSettingsFromEnv,
} from "../dist/test-entry.mjs";

const SECRET = "test-shared-secret-please-rotate-0123456789";

describe("TURN credentials", () => {
  it("derives base64 HMAC-SHA1, byte for byte", () => {
    const username = "1793094582:alice";
    const expected = createHmac("sha1", SECRET).update(username).digest("base64");
    assert.equal(deriveTurnCredential(SECRET, username), expected);
    // The value coturn accepted in the live relay test.
    assert.equal(
      deriveTurnCredential(SECRET, "1793094582:alice"),
      "JUHrcHR/W1Zi8wSzW6O7mAdYpzU=",
    );
  });

  it("mints an expiring username and a credential for it", () => {
    const settings = turnSettingsFromEnv({
      TURN_URLS: "turn:turn.example.com:3478",
      TURN_SECRET: SECRET,
      TURN_TTL_SECONDS: "600",
    });
    assert.ok(settings);

    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const c = mintTurnCredentials(settings, "alice", now);

    const expiry = Math.floor(now / 1000) + 600;
    assert.equal(c.username, `${expiry}:alice`);
    assert.equal(c.credential, deriveTurnCredential(SECRET, c.username));
    assert.deepEqual(c.urls, ["turn:turn.example.com:3478"]);
  });

  it("gives different users different credentials", () => {
    const settings = turnSettingsFromEnv({ TURN_URLS: "turn:x:3478", TURN_SECRET: SECRET });
    const a = mintTurnCredentials(settings, "alice", 1_800_000_000_000);
    const b = mintTurnCredentials(settings, "bob", 1_800_000_000_000);
    assert.notEqual(a.username, b.username);
    assert.notEqual(a.credential, b.credential);
  });

  it("defaults to a one hour lifetime", () => {
    const settings = turnSettingsFromEnv({ TURN_URLS: "turn:x:3478", TURN_SECRET: SECRET });
    assert.equal(settings.ttlSeconds, 3600);
  });

  it("splits and trims multiple URLs", () => {
    const settings = turnSettingsFromEnv({
      TURN_URLS: " turn:a:3478?transport=udp , turns:b:5349 ",
      TURN_SECRET: SECRET,
    });
    assert.deepEqual(settings.urls, ["turn:a:3478?transport=udp", "turns:b:5349"]);
  });

  it("passes static provider credentials through untouched", () => {
    const settings = turnSettingsFromEnv({
      TURN_URLS: "turn:relay.provider.com:3478",
      TURN_USERNAME: "acct",
      TURN_CREDENTIAL: "s3cret",
    });
    const c = mintTurnCredentials(settings);
    assert.equal(c.username, "acct");
    assert.equal(c.credential, "s3cret");
  });

  it("prefers the shared secret over static credentials", () => {
    const settings = turnSettingsFromEnv({
      TURN_URLS: "turn:x:3478",
      TURN_SECRET: SECRET,
      TURN_USERNAME: "acct",
      TURN_CREDENTIAL: "s3cret",
    });
    assert.ok(settings.secret);
    assert.notEqual(mintTurnCredentials(settings, "a", 1_800_000_000_000).credential, "s3cret");
  });

  it("returns null when unconfigured or credentials are incomplete", () => {
    assert.equal(turnSettingsFromEnv({}), null);
    assert.equal(turnSettingsFromEnv({ TURN_URLS: "" }), null);
    // URLs without any credential would 401 every client: treat as unset.
    assert.equal(turnSettingsFromEnv({ TURN_URLS: "turn:x:3478" }), null);
    assert.equal(turnSettingsFromEnv({ TURN_URLS: "turn:x:3478", TURN_USERNAME: "acct" }), null);
  });

  it("ignores a nonsense TTL instead of minting a broken expiry", () => {
    for (const ttl of ["0", "-5", "abc", ""]) {
      const settings = turnSettingsFromEnv({ TURN_URLS: "turn:x:3478", TURN_SECRET: SECRET, TURN_TTL_SECONDS: ttl });
      assert.equal(settings.ttlSeconds, 3600, `ttl=${ttl}`);
    }
  });
});

describe("Cloudflare TURN", () => {
  const KEY = "key-abc123";
  const TOKEN = "api-token-secret";

  const fakeResponse = (body, ok = true, status = 201) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const cfBody = {
    iceServers: [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:443?transport=udp",
          "turn:turn.cloudflare.com:53?transport=udp",
        ],
        username: "user123",
        credential: "cred456",
      },
    ],
  };

  it("reads settings only when both key and token are present", () => {
    assert.equal(cloudflareSettingsFromEnv({}), null);
    assert.equal(cloudflareSettingsFromEnv({ CLOUDFLARE_TURN_KEY_ID: KEY }), null);
    assert.equal(cloudflareSettingsFromEnv({ CLOUDFLARE_TURN_API_TOKEN: TOKEN }), null);
    const s = cloudflareSettingsFromEnv({ CLOUDFLARE_TURN_KEY_ID: KEY, CLOUDFLARE_TURN_API_TOKEN: TOKEN });
    assert.equal(s.keyId, KEY);
    assert.equal(s.ttlSeconds, 3600);
  });

  it("caps the TTL at Cloudflare's 48h maximum", () => {
    const s = cloudflareSettingsFromEnv({
      CLOUDFLARE_TURN_KEY_ID: KEY,
      CLOUDFLARE_TURN_API_TOKEN: TOKEN,
      CLOUDFLARE_TURN_TTL_SECONDS: "999999",
    });
    assert.equal(s.ttlSeconds, 48 * 60 * 60);
  });

  it("calls the documented endpoint with the token and ttl", async () => {
    resetCloudflareCache();
    let seenUrl = null, seenInit = null;
    await fetchCloudflareIceServers(
      { keyId: KEY, apiToken: TOKEN, ttlSeconds: 900 },
      async (url, init) => { seenUrl = url; seenInit = init; return fakeResponse(cfBody); },
    );
    assert.equal(seenUrl, `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY}/credentials/generate-ice-servers`);
    assert.equal(seenInit.method, "POST");
    assert.equal(seenInit.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(seenInit.body), { ttl: 900 });
  });

  it("returns the servers and drops browser-blocked port 53", async () => {
    resetCloudflareCache();
    const servers = await fetchCloudflareIceServers(
      { keyId: KEY, apiToken: TOKEN, ttlSeconds: 3600 },
      async () => fakeResponse(cfBody),
    );
    const turn = servers.find((s) => s.username);
    assert.ok(turn, "TURN entry present");
    assert.deepEqual(turn.urls, [
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:443?transport=udp",
    ]);
    assert.ok(!JSON.stringify(servers).includes(":53?"), "no port 53 URL survives");
    assert.equal(turn.username, "user123");
  });

  it("caches until near expiry instead of calling per request", async () => {
    resetCloudflareCache();
    let calls = 0;
    let now = 1_000_000;
    const settings = { keyId: KEY, apiToken: TOKEN, ttlSeconds: 3600 };
    const fetchStub = async () => { calls++; return fakeResponse(cfBody); };

    await fetchCloudflareIceServers(settings, fetchStub, () => now);
    await fetchCloudflareIceServers(settings, fetchStub, () => now);
    assert.equal(calls, 1, "second call served from cache");

    // Advance past (ttl - 5min margin).
    now += (3600 - 300) * 1000 + 1000;
    await fetchCloudflareIceServers(settings, fetchStub, () => now);
    assert.equal(calls, 2, "refreshed once the margin is crossed");
  });

  it("collapses concurrent misses into one API call", async () => {
    resetCloudflareCache();
    let calls = 0;
    const fetchStub = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return fakeResponse(cfBody);
    };
    const settings = { keyId: KEY, apiToken: TOKEN, ttlSeconds: 3600 };
    await Promise.all([
      fetchCloudflareIceServers(settings, fetchStub),
      fetchCloudflareIceServers(settings, fetchStub),
      fetchCloudflareIceServers(settings, fetchStub),
    ]);
    assert.equal(calls, 1);
  });

  it("throws on a non-2xx response so the caller can fall back to STUN", async () => {
    resetCloudflareCache();
    await assert.rejects(
      () => fetchCloudflareIceServers(
        { keyId: KEY, apiToken: TOKEN, ttlSeconds: 3600 },
        async () => fakeResponse({ error: "bad token" }, false, 401),
      ),
      /401/,
    );
  });

  it("throws when the response has no usable servers, rather than caching junk", async () => {
    resetCloudflareCache();
    await assert.rejects(
      () => fetchCloudflareIceServers(
        { keyId: KEY, apiToken: TOKEN, ttlSeconds: 3600 },
        async () => fakeResponse({ iceServers: [] }),
      ),
      /no usable iceServers/,
    );
  });

  it("does not cache a failure: the next call tries again", async () => {
    resetCloudflareCache();
    let calls = 0;
    const settings = { keyId: KEY, apiToken: TOKEN, ttlSeconds: 3600 };
    const flaky = async () => {
      calls++;
      return calls === 1 ? fakeResponse({ error: "boom" }, false, 500) : fakeResponse(cfBody);
    };
    await assert.rejects(() => fetchCloudflareIceServers(settings, flaky));
    const servers = await fetchCloudflareIceServers(settings, flaky);
    assert.equal(calls, 2);
    assert.ok(servers.length > 0);
  });
});
