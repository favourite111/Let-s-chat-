import { createHmac } from "crypto";

/**
 * TURN credentials.
 *
 * A relay lets two callers connect when neither can reach the other directly
 * (mobile carrier NAT, restrictive corporate wifi). Without one those calls do
 * not connect at all — STUN can only discover addresses, it cannot carry media.
 *
 * Two families of provider are supported:
 *
 *  1. coturn-style shared secret (also Metered's static-auth endpoint):
 *       username   = "<unix-expiry>:<label>"
 *       credential = base64(HMAC-SHA1(secret, username))
 *     The server holds only the secret and computes credentials itself.
 *
 *  2. Cloudflare Realtime TURN:
 *     you hold a long-lived TURN key + API token and ask Cloudflare to mint a
 *     short-lived credential. Different scheme, so it needs an HTTP call.
 *
 * Both produce the same thing for the browser: an iceServers entry with a
 * username and credential that expires on its own.
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
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

export interface CloudflareTurnSettings {
  keyId: string;
  apiToken: string;
  ttlSeconds: number;
}

const DEFAULT_TTL_SECONDS = 3600;
/** Cloudflare refuses credentials longer than this. */
const CLOUDFLARE_MAX_TTL_SECONDS = 48 * 60 * 60;
/** Refresh this long before expiry so a live call never hits a dead credential. */
const REFRESH_MARGIN_SECONDS = 300;

const DEFAULT_CLOUDFLARE_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

/**
 * Cloudflare's API base. Overridable only so this can be exercised against a
 * stand-in server in tests (and for anyone routing egress through a proxy).
 */
function cloudflareApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env["CLOUDFLARE_TURN_API_BASE"]?.replace(/\/+$/, "") || DEFAULT_CLOUDFLARE_API;
}

/**
 * Read coturn-style TURN settings from the environment.
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

  const ttlSeconds = positiveInt(env["TURN_TTL_SECONDS"], DEFAULT_TTL_SECONDS);

  const secret = env["TURN_SECRET"];
  if (secret) return { urls, secret, ttlSeconds };

  const username = env["TURN_USERNAME"];
  const credential = env["TURN_CREDENTIAL"];
  if (username && credential) return { urls, username, credential, ttlSeconds };

  // URLs without any credentials: the relay would reject every request, so
  // treat it as unconfigured rather than handing clients a broken server.
  return null;
}

/** Read Cloudflare TURN settings. Null unless both halves of the key are set. */
export function cloudflareSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CloudflareTurnSettings | null {
  const keyId = env["CLOUDFLARE_TURN_KEY_ID"];
  const apiToken = env["CLOUDFLARE_TURN_API_TOKEN"];
  if (!keyId || !apiToken) return null;

  const ttl = positiveInt(env["CLOUDFLARE_TURN_TTL_SECONDS"], DEFAULT_TTL_SECONDS);
  return { keyId, apiToken, ttlSeconds: Math.min(ttl, CLOUDFLARE_MAX_TTL_SECONDS) };
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
): IceServer {
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

/** Browsers block these ports, so a URL using one is dead weight. */
const BLOCKED_PORTS = new Set(["53"]);

function usesBlockedPort(url: string): boolean {
  const match = url.match(/:(\d+)(?:\?|$)/);
  return Boolean(match && BLOCKED_PORTS.has(match[1]));
}

/**
 * Cached Cloudflare credentials.
 *
 * Minting per request would mean one API call per page load, and Cloudflare
 * rate-limits issuance. Credentials live for an hour, so one fetch serves many
 * visitors — refreshed a few minutes early so nobody is handed an expired one.
 */
interface Cached extends Array<IceServer> {}
let cache: { servers: Cached; expiresAt: number } | null = null;
let inFlight: Promise<Cached> | null = null;

/** Testing seam. */
export function resetCloudflareCache(): void {
  cache = null;
  inFlight = null;
}

/**
 * Ask Cloudflare for a short-lived credential and return the ready-to-use
 * iceServers array.
 *
 * Throws on failure — the caller decides whether to degrade to STUN.
 */
export async function fetchCloudflareIceServers(
  settings: CloudflareTurnSettings,
  fetchImpl: typeof fetch = fetch,
  nowMs: () => number = Date.now,
): Promise<IceServer[]> {
  if (cache && nowMs() < cache.expiresAt) return cache.servers;
  // Collapse concurrent misses into one request.
  if (inFlight) return inFlight;

  const url = `${cloudflareApiBase()}/${encodeURIComponent(settings.keyId)}/credentials/generate-ice-servers`;
  const ttl = Math.min(settings.ttlSeconds, CLOUDFLARE_MAX_TTL_SECONDS);

  inFlight = (async () => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cloudflare TURN returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { iceServers?: IceServer[] };
    const servers = (data.iceServers ?? [])
      .map((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        const usable = urls.filter((u) => !usesBlockedPort(u));
        return { ...server, urls: usable };
      })
      // Drop entries left with no usable URL (port 53 only, say).
      .filter((server) => (Array.isArray(server.urls) ? server.urls.length > 0 : Boolean(server.urls)));

    if (servers.length === 0) throw new Error("Cloudflare TURN returned no usable iceServers");

    const lifetime = Math.max(60, ttl - REFRESH_MARGIN_SECONDS);
    cache = { servers, expiresAt: nowMs() + lifetime * 1000 };
    return servers;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
