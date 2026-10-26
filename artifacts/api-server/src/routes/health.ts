import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { roomCount } from "../lib/rooms";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  roomCount()
    .then((rooms) => {
      res.json({ ...data, uptime: Math.round(process.uptime()), rooms });
    })
    .catch(() => {
      // A dead store must not make the process look healthy-but-useless: still
      // answer 200 (the HTTP layer is fine) but say so.
      res.json({ ...data, uptime: Math.round(process.uptime()), rooms: null });
    });
});

export default router;
