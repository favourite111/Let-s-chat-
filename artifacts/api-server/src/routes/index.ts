import { Router, type IRouter } from "express";
import healthRouter from "./health";
import roomsRouter from "./rooms";
import iceRouter from "./ice";

const router: IRouter = Router();

router.use(healthRouter);
router.use(roomsRouter);
router.use(iceRouter);

export default router;
