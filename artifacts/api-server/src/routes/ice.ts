import { Router } from "express";
import { mintTurnCredentials, turnSettingsFromEnv } from "../lib/turn";

const router = Router();

/**
 * ICE server configuration, served to clients at runtime.
 *
 * Keeping TURN credentials out of the bundle means a relay can be rotated or
 * replaced without shipping a new frontend.
 *
 * Two supported configurations, checked in this order:
 *
 *  1. Time-limited (preferred) — shared secret, per-client credentials:
 *       TURN_URLS="turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349"
 *       TURN_SECRET=<the same static-auth-secret coturn uses>
 *
 *  2. Static — a fixed username/password from a hosting provider:
 *       TURN_URLS=...
 *       TURN_USERNAME=...
 *       TURN_CREDENTIAL=...
 *
 * With a secret, every response carries a different, expiring credential, so
 * the relay cannot be used as a free proxy by anyone who reads this endpoint.
 */
router.get("/ice", (_req, res) => {
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];

  const settings = turnSettingsFromEnv();
  if (settings) {
    iceServers.push(mintTurnCredentials(settings));
  }

  // Minted credentials are per-request, so they must not be cached and shared
  // between users. (They are only valid for TURN_TTL_SECONDS anyway.)
  res.setHeader("Cache-Control", settings ? "no-store" : "public, max-age=300");
  res.json({ iceServers });
});

export default router;
