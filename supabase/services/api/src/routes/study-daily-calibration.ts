import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { createAdminClient } from "../lib/supabase";
import { requireCronSecret } from "../middleware/auth";
import { runDailyCalibration } from "../lib/study-daily-calibration";

export const studyDailyCalibrationRouter = Router();

/**
 * 功能 B：试水期 → 自动校准每日学习量（需 x-cron-secret）。
 *
 * 每天（或每周一）触发一次：对 FEISHU_RECEIVER_USER_ID 名下所有 status='applied'
 * 的学习计划，算上一自然周的「平均每天真实完成分钟数」，作为该书新的 daily_minutes_cap，
 * 再把未来还没开始的学习块按新上限重新铺时间（回写 study_plan_items 和 todos）。
 *
 * 每个自然周只校准一次（study_plans.params.daily_cap_calibrated_week 防重复）；
 * 上周完全没有完成数据的计划不写标记、不改上限。
 *
 * GET 也可用，方便 crontab 直接 curl；逻辑与 POST 一致。
 */
async function handleCalibration(_req: Request, res: Response): Promise<void> {
  const userId = config.feishuReceiverUserId;
  if (!userId) {
    res.status(500).json({ error: "FEISHU_RECEIVER_USER_ID 未配置" });
    return;
  }

  const admin = createAdminClient();
  const report = await runDailyCalibration(admin, userId);

  // 审计一条（若有计划被校准）
  if (report.calibrated > 0) {
    try {
      const firstSpaceId = report.plans[0]?.space_id;
      await admin.from("ai_actions").insert({
        space_id: firstSpaceId ?? null,
        user_id: userId,
        action_type: "study_daily_calibration",
        payload: {
          week_key: report.week_key,
          checked: report.checked,
          calibrated: report.calibrated,
          plans: report.plans.map((p) => ({
            plan_id: p.plan_id,
            book_title: p.book_title,
            last_week_done_minutes: p.last_week_done_minutes,
            avg_per_day: p.avg_per_day,
            old_cap: p.old_cap,
            new_cap: p.new_cap,
            rescheduled: p.rescheduled,
            skipped_reason: p.skipped_reason,
          })),
        },
        result_todo_ids: [],
        status: "applied",
      });
    } catch {
      // 审计失败不影响主流程
    }
  }

  res.json({ ok: true, ...report });
}

studyDailyCalibrationRouter.post(
  "/jobs/study-daily-calibration",
  requireCronSecret,
  handleCalibration,
);

studyDailyCalibrationRouter.get(
  "/jobs/study-daily-calibration",
  requireCronSecret,
  handleCalibration,
);
