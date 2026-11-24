import { Router } from "express";
import { config } from "../config";
import { dayBounds } from "../lib/day-bounds";
import { sendDailyPlanCard } from "../lib/feishu";
import {
  buildCard,
  loadStudyDigest,
  TODO_SELECT,
  type PlanTodo,
  type StudyPlanDigest,
} from "../lib/plan-card";
import {
  buildBusy,
  findFreeSlot,
  occupantsOf,
  type BusyEntry,
} from "../lib/occupancy";
import { listUserSpaceIds } from "../lib/space";
import { createAdminClient } from "../lib/supabase";
import { requireCronSecret } from "../middleware/auth";
import { priorityWeight } from "../services/todos";
import { runDailyCalibration } from "../lib/study-daily-calibration";

const WORKDAY_START = "09:00";
const WORKDAY_END = "18:00";
const DEFAULT_DURATION_MIN = 60;

export const dailyPlanPushRouter = Router();

/**
 * 每日自动排程 + 飞书推送（需 x-cron-secret）。
 *
 * 流程：
 *  1. 拉目标用户（FEISHU_RECEIVER_USER_ID）的全部空间
 *  2. 拉「今天已排期」+「未排期」任务
 *  3. 未排期任务用 findFreeSlot 确定性排进未来空闲槽（写回 DB，网页端同步可见）
 *  4. 拼交互卡片 → 按 open_id/user_id/email 直发 → 推飞书
 *  5. 记 ai_actions 审计
 *
 * 卡片里的每个学习块 / 日程行都带「完成」按钮，点了走 /feishu/card-callback
 * 回写 todos.status（详见 lib/plan-card.ts 与 routes/feishu-card.ts）。
 *
 * ?no_schedule=1（或 body.no_schedule=true）只推卡片不写库，用于安全预览。
 *
 * P0 只服务环境变量指定的单用户；多用户绑定（profiles.feishu_open_id）留到 P1。
 */
dailyPlanPushRouter.post(
  "/jobs/daily-plan-push",
  requireCronSecret,
  async (req, res) => {
    try {
      const userId = config.feishuReceiverUserId;
      if (!userId) {
        res.status(500).json({ error: "FEISHU_RECEIVER_USER_ID 未配置" });
        return;
      }

      const noSchedule =
        req.query.no_schedule === "1" || req.body?.no_schedule === true;

      const admin = createAdminClient();

      // 功能 B：推卡前先跑一次「试水期→每日学习量校准」。
      // no_schedule 预览模式跳过（不写库、不改计划）。
      let calibration: Awaited<ReturnType<typeof runDailyCalibration>> | null = null;
      if (!noSchedule) {
        try {
          calibration = await runDailyCalibration(admin, userId);
        } catch {
          calibration = null; // 校准失败不阻断推卡
        }
      }

      const { data: profile } = await admin
        .from("profiles")
        .select("timezone")
        .eq("id", userId)
        .maybeSingle();
      const timezone = (profile?.timezone as string | undefined) || "Asia/Shanghai";

      const spaceIds = await listUserSpaceIds(admin, userId);
      if (spaceIds.length === 0) {
        res.json({ ok: true, date: dayBounds(timezone).localDate, scheduled: 0, pushed: false });
        return;
      }

      const { localDate, startIso, endIso } = dayBounds(timezone);

      // 已排期任务（全量，供 busy 与「今天」列表）
      const { data: scheduledRows } = await admin
        .from("todos")
        .select(TODO_SELECT)
        .in("space_id", spaceIds)
        .neq("status", "done")
        .not("start_at", "is", null);
      const scheduled = (scheduledRows ?? []) as PlanTodo[];

      // 未排期任务
      const { data: unscheduledRows } = await admin
        .from("todos")
        .select(TODO_SELECT)
        .in("space_id", spaceIds)
        .neq("status", "done")
        .is("start_at", null);
      const unscheduled = (unscheduledRows ?? []) as PlanTodo[];

      // 未排期排序：优先级降序 → due 升序
      unscheduled.sort((a, b) => {
        const pw = priorityWeight(b.priority ?? null) - priorityWeight(a.priority ?? null);
        if (pw !== 0) return pw;
        return (a.due_at ?? "").localeCompare(b.due_at ?? "");
      });

      const busy = buildBusy(scheduled);
      const accepted: BusyEntry[] = [];
      const applied: string[] = [];
      const skipped: Array<{ title: string; reason: string }> = [];

      for (const todo of noSchedule ? [] : unscheduled) {
        const owners = occupantsOf(todo);
        if (owners.length === 0) {
          skipped.push({ title: todo.title, reason: "无占用者（无指派且无创建人）" });
          continue;
        }

        const durationMs = (todo.duration_minutes ?? DEFAULT_DURATION_MIN) * 60 * 1000;
        const pool = [...busy, ...accepted];
        const slot = findFreeSlot({
          busy: pool,
          userIds: owners,
          durationMs,
          from: Date.now(),
          workdayStart: WORKDAY_START,
          workdayEnd: WORKDAY_END,
          timezone,
          ignoreTodoIds: new Set([todo.id]),
        });

        if (!slot) {
          skipped.push({ title: todo.title, reason: "未来 14 天工作时段无空闲" });
          continue;
        }

        const { error: upErr } = await admin
          .from("todos")
          .update({
            start_at: new Date(slot.start).toISOString(),
            end_at: new Date(slot.end).toISOString(),
            is_all_day: false,
          })
          .eq("id", todo.id);
        if (upErr) {
          skipped.push({ title: todo.title, reason: upErr.message });
          continue;
        }

        applied.push(todo.id);
        for (const uid of owners) {
          accepted.push({
            start: slot.start,
            end: slot.end,
            todo_id: todo.id,
            title: todo.title,
            user_id: uid,
          });
        }
      }

      // 今天列表：已排期中落在今天的 + 本次新排入的（可能落在未来）
      const today = scheduled.filter((t) => {
        if (t.start_at && t.start_at <= endIso && (t.end_at || t.start_at) >= startIso) return true;
        return false;
      });
      const future = unscheduled.filter((u) => applied.includes(u.id));
      today.sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? ""));

      // 今日学习块 + 进度落后（Step 3；失败不影响任务推送）
      let study: StudyPlanDigest[] = [];
      let studyError: string | null = null;
      try {
        study = await loadStudyDigest(admin, userId, {
          startIso,
          endIso,
          nowMs: Date.now(),
        });
      } catch (e) {
        studyError = e instanceof Error ? e.message : "unknown";
      }

      const card = buildCard({
        localDate,
        timezone,
        today,
        future,
        skippedCount: skipped.length,
        study,
        webBaseUrl: config.webBaseUrl,
      });

      // 推飞书（优先 open_id / user_id 直发，均无需 contact:user.id:readonly 权限）
      let pushed = false;
      let pushError: string | null = null;
      const hasReceiver =
        !!config.feishuReceiverOpenId ||
        !!config.feishuReceiverFeishuUserId ||
        !!config.feishuReceiverEmail ||
        !!config.feishuReceiverMobile;
      if (config.feishuAppId && config.feishuAppSecret && hasReceiver) {
        try {
          await sendDailyPlanCard({
            appId: config.feishuAppId,
            appSecret: config.feishuAppSecret,
            openId: config.feishuReceiverOpenId,
            feishuUserId: config.feishuReceiverFeishuUserId,
            email: config.feishuReceiverEmail,
            mobile: config.feishuReceiverMobile,
            card,
          });
          pushed = true;
        } catch (e) {
          pushError = e instanceof Error ? e.message : "unknown";
        }
      } else {
        pushError = "飞书凭证或接收人未配置";
      }

      // 审计
      await admin.from("ai_actions").insert({
        space_id: spaceIds[0],
        user_id: userId,
        action_type: "daily_plan_push",
        payload: {
          local_date: localDate,
          scheduled: applied,
          skipped: skipped.map((s) => s.title),
          pushed,
          push_error: pushError,
          no_schedule: noSchedule,
          study: study.map((p) => ({
            plan_id: p.planId,
            book_title: p.bookTitle,
            today_units: p.todayItems.length,
            total_units: p.totalUnits,
            done_units: p.doneUnits,
            overdue_units: p.overdueUnits,
            overdue_minutes: p.overdueMinutes,
          })),
          study_error: studyError,
          calibration: calibration
            ? {
                week_key: calibration.week_key,
                checked: calibration.checked,
                calibrated: calibration.calibrated,
                plans: calibration.plans.map((p) => ({
                  plan_id: p.plan_id,
                  book_title: p.book_title,
                  last_week_done_minutes: p.last_week_done_minutes,
                  avg_per_day: p.avg_per_day,
                  old_cap: p.old_cap,
                  new_cap: p.new_cap,
                  rescheduled: p.rescheduled,
                  skipped_reason: p.skipped_reason,
                })),
              }
            : null,
        },
        result_todo_ids: applied,
        status: pushed || applied.length > 0 ? "applied" : "failed",
      });

      res.json({
        ok: true,
        date: localDate,
        scheduled: applied.length,
        skipped,
        today_count: today.length + future.length,
        pushed,
        push_error: pushError,
        no_schedule: noSchedule,
        study_today: study.reduce((s, p) => s + p.todayItems.length, 0),
        study_overdue: study.reduce((s, p) => s + p.overdueUnits, 0),
        study_error: studyError,
        calibration: calibration
          ? { week_key: calibration.week_key, calibrated: calibration.calibrated }
          : null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  },
);

// 仅供本地自测渲染卡片结构（不参与运行时逻辑）
export const __cardHelpers = { buildCard, loadStudyDigest };
