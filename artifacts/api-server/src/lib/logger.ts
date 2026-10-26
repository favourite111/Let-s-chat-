import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * In production we write **synchronously** to stdout on purpose: the process
 * exits on fatal errors (failed bind, storage init failure, SIGTERM), and an
 * asynchronous transport would drop exactly the log line that explains why.
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
  },
  isProduction
    ? pino.destination({ dest: 1, sync: true })
    : pino.transport({
        target: "pino-pretty",
        options: { colorize: true },
      }),
);
