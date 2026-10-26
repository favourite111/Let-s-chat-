import http from "http";
import { Server as SocketIOServer } from "socket.io";
import app from "./app";
import { logger } from "./lib/logger";
import { setupSignaling } from "./lib/signaling";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = http.createServer(app);

const allowedOrigins = (process.env["CORS_ORIGINS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new SocketIOServer(httpServer, {
  path: "/socket.io",
  // Mirror the HTTP CORS policy: explicit allowlist when configured, otherwise
  // reflect the caller's origin (never a blanket `*`).
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e5, // 100 kB is plenty for SDP + ICE payloads
  connectTimeout: 20_000,
  pingTimeout: 25_000,
});

setupSignaling(io);

httpServer.on("error", (err) => {
  // EADDRINUSE and friends must fail loudly with a non-zero exit code so the
  // platform restarts us instead of leaving a silent, broken process.
  logger.fatal({ err }, "HTTP server error");
  process.exit(1);
});

httpServer.listen(port, () => {
  logger.info({ port, env: process.env.NODE_ENV ?? "development" }, "Server listening");
});

/**
 * Last line of defence: a bad payload in a handler must degrade to a logged
 * error, never a dead process. (This is exactly what used to happen when a
 * client emitted `ice-candidate` with a null payload.)
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
    // Stop accepting connections, notify peers, then close the sockets.
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await io.close();
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
  }

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
