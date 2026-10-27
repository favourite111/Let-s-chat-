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

import { deriveTurnCredential, mintTurnCredentials, turnSettingsFromEnv } from "../dist/test-entry.mjs";

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
