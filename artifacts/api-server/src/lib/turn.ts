import { createHmac } from "crypto";

/**
 * TURN credentials.
 *
 * A relay lets two callers connect when neither can reach the other directly
 * (mobile carrier NAT, restrictive corporate wifi). Without one those calls do
 * not connect at all — STUN can only discover addresses, it cannot carry media.
 *
 * The naive setup hands every visitor the same username/password, which means
 * anyone who loads the page can push traffic through your relay on your bill.
 * The alternative — and what coturn has supported for years — is time-limited
 * credentials:
 *
 *   username   = "<unix-expiry>:<any label>"
 *   credential = base64(HMAC-SHA1(shared_secret, username))
 *
 * The server holds only the shared secret. It recomputes the HMAC, checks the
 * expiry, and rejects anything stale. Credentials expire on their own, so a
 * leaked one is worthless within the hour and there is nothing to rotate.
 *
 * This is the "TURN REST API" scheme, supported natively by coturn
 * (`use-auth-secret`) and by most hosted TURN providers.
 */

export interface TurnConfig {
  urls: string[];
  username: string;
  credential: string;
}

export interface TurnSettings {
  urls: string[];
  /** Shared secret for time-limited credentials. Preferred. */
  secret?: string;
  /** Static credentials, for providers that issue a fixed username/password. */
  username?: string;
  credential?: string;
  /** How long a minted credential stays valid. */
  ttlSeconds: number;
}

const DEFAULT_TTL_SECONDS = 3600;

/**
 * Read TURN settings from the environment.
 *
 * Returns null when no relay is configured — the caller then serves STUN only,
 * which is a working (if fragile) configuration, not an error.
 */
export function turnSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): TurnSettings | null {
  const rawUrls = env["TURN_URLS"];
  if (!rawUrls) return null;

  const urls = rawUrls
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) return null;

  const ttl = Number(env["TURN_TTL_SECONDS"]);
  const ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_SECONDS;

  const secret = env["TURN_SECRET"];
  if (secret) return { urls, secret, ttlSeconds };

  const username = env["TURN_USERNAME"];
  const credential = env["TURN_CREDENTIAL"];
  if (username && credential) return { urls, username, credential, ttlSeconds };

  // URLs without any credentials: the relay would reject every request, so
  // treat it as unconfigured rather than handing clients a broken server.
  return null;
}

/** base64(hmac-sha1(secret, username)) — coturn's formula, byte for byte. */
export function deriveTurnCredential(secret: string, username: string): string {
  return createHmac("sha1", secret).update(username).digest("base64");
}

/**
 * Build the username/credential pair a client should use right now.
 *
 * `nowMs` is injectable so the expiry is testable without waiting an hour.
 */
export function mintTurnCredentials(
  settings: TurnSettings,
  label = "videocall",
  nowMs: number = Date.now(),
): TurnConfig {
  if (!settings.secret) {
    // Static provider credentials: nothing to mint.
    return {
      urls: settings.urls,
      username: settings.username ?? "",
      credential: settings.credential ?? "",
    };
  }

  const expiry = Math.floor(nowMs / 1000) + settings.ttlSeconds;
  const username = `${expiry}:${label}`;
  return {
    urls: settings.urls,
    username,
    credential: deriveTurnCredential(settings.secret, username),
  };
}
