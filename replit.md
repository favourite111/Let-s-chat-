# VideoCall

A browser-based 1-on-1 video call app. No accounts needed — create a room, share the link, connect face-to-face instantly.

## Architecture

### Frontend (`artifacts/video-call`)
- React + Vite app served at `/`
- Pages: Home (`/`) and Room (`/room/:roomId`)
- Uses WebRTC for peer-to-peer video/audio
- Uses Socket.IO client for WebRTC signaling via `/socket.io`
- API hooks generated from OpenAPI spec

### Backend (`artifacts/api-server`)
- Express server on port 8080
- REST API at `/api`:
  - `POST /api/rooms` — create a new room
  - `GET /api/rooms/:roomId` — check if a room exists
- Socket.IO server at `/socket.io` for WebRTC signaling:
  - Relays `offer`, `answer`, `ice-candidate` events between peers
  - Handles room join/leave/disconnect lifecycle
  - Max 2 participants per room

## Stack

- **Frontend**: React, Vite, Tailwind CSS, Wouter (routing), TanStack Query, Socket.IO client
- **Backend**: Express, Socket.IO, TypeScript/ESBuild
- **API Contract**: OpenAPI 3.1 → Orval codegen (hooks + Zod schemas)

## Key Files

- `artifacts/video-call/src/pages/home.tsx` — landing page (create/join room)
- `artifacts/video-call/src/pages/room.tsx` — call room with WebRTC + Socket.IO logic
- `artifacts/api-server/src/lib/signaling.ts` — Socket.IO signaling relay
- `artifacts/api-server/src/routes/rooms.ts` — room REST API
- `lib/api-spec/openapi.yaml` — API contract
