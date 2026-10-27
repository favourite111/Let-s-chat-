import http from "http";
import { Server as SocketIOServer } from "socket.io";
import app from "./app";
import { logger } from "./lib/logger";
import { setupSignaling } from "./lib/signaling";
import { closeRooms, initRooms, roomLimits } from "./lib/rooms";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const allowedOrigins = (process.env["CORS_ORIGINS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Optional Redis adapter: only needed when you run more than one instance.
 * A single VPS process runs perfectly well without it.
 */
async function attachRedisAdapter(io: SocketIOServer): Promise<boolean> {
  const url = process.env["REDIS_URL"];
  if (!url) return false;

  try {
    const { createClient } = await import("redis");
    const { createAdapter } = await import("@socket.io/redis-adapter");

    const pub = createClient({ url });
    const sub = pub.duplicate();
    pub.on("error", (err: unknown) => logger.error({ err }, "Redis pub client error"));
    sub.on("error", (err: unknown) => logger.error({ err }, "Redis sub client error"));

    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    logger.info("Socket.IO Redis adapter enabled (multi-instance mode)");
    return true;
  } catch (err) {
    logger.error({ err }, "Could not enable the Redis adapter; continuing single-instance");
    return false;
  }
}

async function main() {
  // Storage boots before the server accepts traffic, so the first request can
  // never hit a half-initialised store.
  const { store, presence } = await initRooms();
  logger.info(
    {
      roomStore: store.kind,
      presenceStore: presence.kind,
      storage: process.env["SQLITE_PATH"] ?? process.env["DATABASE_URL"] ? "persistent" : "default",
      ...roomLimits(),
    },
    "Storage initialised",
  );

  const httpServer = http.createServer(app);

  const io = new SocketIOServer(httpServer, {
    path: "/socket.io",
    cors: {
      origin: allowedOrigins.length > 0 ? allowedOrigins : true,
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 1e5, // 100 kB is plenty for SDP + ICE payloads
    connectTimeout: 20_000,
    // A dead socket is detected in ~30 s instead of ~50 s. The default pair
    // (25 s + 25 s) is what kept a closed mobile tab holding a seat long
    // enough for the next join to be refused with "room full".
    pingInterval: 10_000,
    pingTimeout: 20_000,
  });

  await attachRedisAdapter(io);
  setupSignaling(io);

  httpServer.on("error", (err) => {
    logger.fatal({ err }, "HTTP server error");
    process.exit(1);
  });

  httpServer.listen(port, () => {
    logger.info({ port, env: process.env.NODE_ENV ?? "development" }, "Server listening");
  });

  /**
   * Last line of defence: a bad payload must degrade to a logged error, never
   * a dead process. (This is what used to happen on `emit("ice-candidate", null)`.)
   */
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
  });

  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");

    const forceExit = setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await io.close();
      await closeRooms();
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
    }

    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
