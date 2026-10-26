import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { roomCount } from "../lib/rooms";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({ ...data, uptime: Math.round(process.uptime()), rooms: roomCount() });
});

export default router;
