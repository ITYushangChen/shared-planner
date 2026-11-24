import cors from "cors";
import express from "express";
import { assertRuntimeEnv, config } from "./config";
import { aiConflictSuggestRouter } from "./routes/ai-conflict-suggest";
import { aiCreateTodosRouter } from "./routes/ai-create-todos";
import { aiReorderRouter } from "./routes/ai-reorder";
import { aiScheduleRouter } from "./routes/ai-schedule";
import { aiReportPlainRouter } from "./routes/ai-report-plain";
import { knowledgeRouter } from "./routes/knowledge";
import { studyRouter } from "./routes/study";
import { docsRouter } from "./routes/docs";
import { dailySummaryRouter } from "./routes/daily-summary";
import { dailyPlanPushRouter } from "./routes/daily-plan-push";
import { feishuCardRouter } from "./routes/feishu-card";
import { studyDailyCalibrationRouter } from "./routes/study-daily-calibration";

assertRuntimeEnv();

const app = express();

app.use(
  cors({
    origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","),
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "shared-planner-api",
    model: config.deepseekModel,
  });
});

app.use("/ai", aiCreateTodosRouter);
app.use("/ai", aiScheduleRouter);
app.use("/ai", aiReorderRouter);
app.use("/ai", aiConflictSuggestRouter);
app.use("/ai", aiReportPlainRouter);
app.use("/ai", knowledgeRouter);
app.use("/ai", studyRouter);
app.use("/docs", docsRouter);
app.use("/ai", dailySummaryRouter);
app.use(dailySummaryRouter);
app.use(dailyPlanPushRouter);
app.use(feishuCardRouter);
app.use(studyDailyCalibrationRouter);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const message = err instanceof Error ? err.message : "Server error";
    res.status(500).json({ error: message });
  },
);

app.listen(config.port, () => {
  console.log(`ShareTodo API listening on :${config.port}`);
});
