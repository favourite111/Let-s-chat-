import { Router } from "express";
import { logger } from "../lib/logger";
import {
  cloudflareSettingsFromEnv,
  fetchCloudflareIceServers,
  fetchMeteredIceServers,
  meteredSettingsFromEnv,
  mintTurnCredentials,
  turnSettingsFromEnv,
  type IceServer,
} from "../lib/turn";

const router = Router();

const STUN_ONLY: IceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/**
 * ICE server configuration, served to clients at runtime.
 *
 * Keeping TURN credentials out of the bundle means a relay can be rotated or
 * replaced without shipping a new frontend. Three configurations, first match
 * wins:
 *
 *  1. Cloudflare Realtime TURN (1 TB/month free):
 *       CLOUDFLARE_TURN_KEY_ID=...
 *       CLOUDFLARE_TURN_API_TOKEN=...
 *
 *  2. Metered Open Relay (20 GB/month free):
 *       METERED_API_KEY=...
 *
 *  3. coturn-style shared secret, per-client credentials:
 *       TURN_URLS="turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349"
 *       TURN_SECRET=<the same static-auth-secret coturn uses>
 *
 *  4. Static provider credentials:
 *       TURN_URLS=...
 *       TURN_USERNAME=...
 *       TURN_CREDENTIAL=...
 *
 * A relay failure must never take the call down with it: if credentials cannot
 * be obtained we answer with STUN only, which still connects callers who are
 * directly reachable.
 */
router.get("/ice", async (_req, res) => {
  const iceServers: IceServer[] = [...STUN_ONLY];
  let minted = false;

  const cloudflare = cloudflareSettingsFromEnv();
  const metered = meteredSettingsFromEnv();

  if (cloudflare) {
    try {
      iceServers.push(...(await fetchCloudflareIceServers(cloudflare)));
      minted = true;
    } catch (err) {
      logger.error({ err }, "Cloudflare TURN credentials unavailable, serving STUN only");
    }
  } else if (metered) {
    try {
      iceServers.push(...(await fetchMeteredIceServers(metered)));
      minted = true;
    } catch (err) {
      logger.error({ err }, "Metered TURN credentials unavailable, serving STUN only");
    }
  } else {
    const settings = turnSettingsFromEnv();
    if (settings) {
      iceServers.push(mintTurnCredentials(settings));
      minted = true;
    }
  }

  // Minted credentials are per-request (Cloudflare's at least are time-boxed),
  // so they must not be shared between users by an intermediary cache.
  res.setHeader("Cache-Control", minted ? "no-store" : "public, max-age=300");
  res.json({ iceServers });
});

export default router;
