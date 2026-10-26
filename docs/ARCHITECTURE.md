# Architecture & known limitations

## Request / media flow

1. `POST /api/rooms` creates a room in the in-memory store and returns a 12-character code (60 bits of entropy, unambiguous base32).
2. The browser opens `/room/:roomId`, fetches `/api/ice` for STUN/TURN config, then requests camera + microphone.
3. The browser connects to Socket.IO and emits `join-room`. The server accepts **only if the room exists** and has fewer than 2 participants.
4. The peer already in the room receives `user-connected` and creates the SDP offer; the newcomer answers. Keeping a single deterministic offerer avoids glare for two peers.
5. ICE candidates are buffered client-side until the remote description is set, then flushed.
6. Mute and camera-off are implemented with `track.enabled` (no renegotiation) and mirrored to the peer via `media-state`.
7. On `disconnect` the client shows "Reconnecting…"; Socket.IO's automatic reconnect fires `connect` again, which re-emits `join-room` and rebuilds the peer connection. `iceconnectionstatechange` triggers `restartIce()` on failure.

## Server modules

| File | Responsibility |
|---|---|
| `src/lib/rooms.ts` | Room store: creation, join/leave, live participant counts, TTL sweep, capacity cap |
| `src/lib/signaling.ts` | Validated Socket.IO relay; enforces room membership and per-socket rate limits |
| `src/routes/rooms.ts` | REST endpoints, Zod validation from the OpenAPI contract |
| `src/routes/ice.ts` | TURN/STUN config from environment |
| `src/app.ts` | Helmet CSP, CORS policy, compression, rate limits, JSON 404s, SPA fallback |
| `src/index.ts` | Socket.IO wiring, crash guards, graceful shutdown |

Every inbound socket payload is validated before use and each handler is wrapped, so a malformed message can no longer take the process down (`test/smoke.test.mjs` covers this).

## Deliberate limitations

**No horizontal scaling.** Rooms and socket membership live in process memory. Two instances would see different room tables and could not relay between them. `render.yaml` pins `numInstances: 1`. To scale:

- move rooms to Postgres (the `lib/db` Drizzle package is scaffolded for exactly this),
- add `@socket.io/redis-adapter` plus sticky sessions so a room's sockets share one replica,
- keep TURN credentials out of the client and issue short-lived ones per session.

**Rooms do not survive a restart.** Empty rooms are swept after 2 hours; a redeploy drops every active room.

**Not verified end-to-end encryption.** WebRTC always encrypts media in transit (DTLS-SRTP), so the UI says *"Encrypted in transit"*, not "end-to-end". True E2EE with tamper-evident signalling requires identity keys exchanged out-of-band and fingerprint comparison — those are unauthenticated right now, so a compromised signalling server could MITM a call.

**Two participants only.** Supporting 3+ peers needs an SFU (mediasoup, LiveKit, Janus) rather than mesh peer connections.

**No TURN by default.** The client falls back to public STUN. On carrier-grade NAT / symmetric NAT — common on mobile networks — a call will fail to connect without your own TURN relay configured through `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.

**`artifacts/mockup-sandbox`** is leftover Replit design-canvas tooling. It is not part of the product and can be deleted along with the unused shadcn components in `artifacts/video-call/src/components/ui` (only `button`, `card`, `input`, `tooltip`, `toast`, `toaster` and `sonner` are imported).

## Roadmap

- [ ] Persist rooms in Postgres; Redis adapter for multi-instance
- [ ] Coturn deployment with time-limited credentials
- [ ] In-call chat over `RTCDataChannel`
- [ ] Screen sharing (renegotiation via the perfect-negotiation pattern)
- [ ] Group calls (SFU)
- [ ] Room password / waiting room / lock
- [ ] Recording (`MediaRecorder`)
- [ ] Playwright smoke test with fake media devices
- [ ] E2EE with verifiable identity
- [ ] Delete the unused UI kit and the mockup sandbox
