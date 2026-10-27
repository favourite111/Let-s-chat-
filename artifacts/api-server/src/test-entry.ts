/**
 * Test-only entry point.
 *
 * The production bundle (src/index.ts) starts a server and exports nothing, so
 * unit/integration tests import this instead. It is bundled to
 * dist/test-entry.mjs by `pnpm run build:test` and never shipped.
 */
export { MemoryRoomStore } from "./lib/store/memory";
export { SqliteRoomStore } from "./lib/store/sqlite";
export { PostgresRoomStore } from "./lib/store/postgres";
export { MemoryPresence } from "./lib/store/presence-memory";
export { RedisPresence } from "./lib/store/presence-redis";
export type {
  ParticipantRecord,
  PresenceStore,
  RoomRecord,
  RoomStore,
} from "./lib/store/types";
export {
  abandonRoom,
  closeRoomByHost,
  closeRooms,
  createRoom,
  getRoom,
  initRooms,
  joinRoom,
  leaveRoom,
  normaliseParticipantId,
  purgeStaleParticipants,
  removeParticipantByHost,
  roomParticipants,
  roomSockets,
  sweepExpired,
  toPublicParticipants,
  toPublicRoom,
  verifyHost,
} from "./lib/rooms";
export {
  cloudflareSettingsFromEnv,
  fetchMeteredIceServers,
  meteredSettingsFromEnv,
  resetMeteredCache,
  deriveTurnCredential,
  fetchCloudflareIceServers,
  mintTurnCredentials,
  resetCloudflareCache,
  turnSettingsFromEnv,
} from "./lib/turn";
export type { IceServer } from "./lib/turn";
