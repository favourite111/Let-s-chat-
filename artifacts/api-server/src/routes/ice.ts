import { Router } from "express";

const router = Router();

/**
 * ICE server configuration, served to clients at runtime.
 *
 * Keeping TURN credentials out of the bundle means a relay can be rotated or
 * replaced without shipping a new frontend, and lets deployments supply their
 * own coturn instance via env vars:
 *
 *   TURN_URLS="turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349"
 *   TURN_USERNAME=...
 *   TURN_CREDENTIAL=...
 */
router.get("/ice", (_req, res) => {
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];

  const turnUrls = process.env["TURN_URLS"];
  if (turnUrls) {
    iceServers.push({
      urls: turnUrls.split(",").map((url) => url.trim()).filter(Boolean),
      username: process.env["TURN_USERNAME"] ?? "",
      credential: process.env["TURN_CREDENTIAL"] ?? "",
    });
  }

  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ iceServers });
});

export default router;
