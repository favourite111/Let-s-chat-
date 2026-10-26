import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors, { type CorsOptions } from "cors";
import compression from "compression";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Behind Replit/Render/any reverse proxy the client IP arrives in
// X-Forwarded-For. Set TRUST_PROXY=0 when the app is exposed directly.
const trustProxy = Number(process.env["TRUST_PROXY"] ?? 1);
app.set("trust proxy", trustProxy);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(
  helmet({
    // The app is designed to be embeddable (previews, iframes in docs, etc.).
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "frame-ancestors": ["*"],
        // HTTP-only deployments (local docker, plain IPs) would otherwise have
        // every subresource rewritten to https:// and fail to load.
        "upgrade-insecure-requests": null,
        // Socket.IO needs to reach the same origin; media comes from the peer.
        "connect-src": ["'self'", "ws:", "wss:"],
        "media-src": ["'self'", "blob:", "mediastream:"],
        "img-src": ["'self'", "data:", "blob:"],
      },
    },
  }),
);

app.use(compression());

/**
 * CORS: if CORS_ORIGINS is set (comma separated) only those origins are
 * allowed. Otherwise reflect the request origin instead of answering with `*`,
 * which keeps the app working on preview/alias domains without opening it to
 * every website on the internet when credentials are involved.
 */
const allowedOrigins = (process.env["CORS_ORIGINS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions: CorsOptions =
  allowedOrigins.length > 0
    ? {
        origin(origin, callback) {
          if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
          return callback(new Error("Not allowed by CORS"));
        },
      }
    : { origin: true };

app.use(cors(corsOptions));

// Room creation is the expensive write: keep it tighter than general traffic.
// Both limits are per IP, so keep headroom for users behind carrier-grade NAT.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env["RATE_LIMIT_PER_MINUTE"] ?? 600),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

const createRoomLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env["ROOM_CREATE_LIMIT_PER_MINUTE"] ?? 30),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many rooms created, slow down" },
});

app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));

app.use("/api", apiLimiter);
// Only POST /rooms is throttled tightly — reading a room must stay cheap.
app.post("/api/rooms", createRoomLimiter);
app.use("/api", router);

// Unknown API routes must not fall through to the SPA's index.html.
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

if (process.env.NODE_ENV === "production") {
  const frontendPath = path.resolve(process.cwd(), "artifacts/video-call/dist/public");
  app.use(express.static(frontendPath, { index: false, maxAge: "1h" }));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });
}

// Central error handler: never leak stack traces, always answer JSON for /api.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  logger.error({ err, path: req.path }, "Unhandled request error");
  if (req.path.startsWith("/api")) {
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.status(500).send("Internal server error");
});

export default app;
