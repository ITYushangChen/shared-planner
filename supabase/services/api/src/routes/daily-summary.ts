import { Router } from "express";
import { z } from "zod";
import { dayBounds } from "../lib/day-bounds";
import { assertSpaceMember } from "../lib/space";
import { priorityWeight } from "../services/todos";
import { createAdminClient } from "../lib/supabase";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth, requireCronSecret } from "../middleware/auth";

type SumTodo = {
  id: string;
  title: string | null;
  priority: string | null;
  status: string | null;
  start_at: string | null;
  end_at: string | null;
  due_at: string | null;
};

function isHighPriority(priority: string | null | undefined): boolean {
  return priority === "high";
}

// 按用户时区把 ISO 时间格式化为 YYYY-MM-DD
function tzYmd(timezone: string, iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

// 相对日期描述：明天 / 后天 / X 月 X 日
function relDateLabel(timezone: string, iso: string, localDate: string): string {
  const ymd = tzYmd(timezone, iso);
  const diffDays = Math.round(
    (new Date(ymd + "T00:00:00Z").getTime() -
      new Date(localDate + "T00:00:00Z").getTime()) /
      86400000,
  );
  if (diffDays <= 1) return "明天";
  if (diffDays === 2) return "后天";
  const [, m, d] = ymd.split("-");
  return `${Number(m)} 月 ${Number(d)} 日`;
}

// 按固定模板拼接待办摘要（确定性格式，不依赖模型自由发挥）
function buildSummaryText(opts: {
  localDate: string;
  timezone: string;
  today: SumTodo[];
  overdue: SumTodo[];
  upcoming: SumTodo[];
  unscheduled: SumTodo[];
}): string {
  const { today, overdue, upcoming, unscheduled, localDate, timezone } = opts;
  const lines: string[] = [];

  if (today.length === 0) {
    lines.push("今天没有指派给你的任务。");
  } else {
    const names = today.map((t) => t.title || "未命名").join("、");
    lines.push(`今天有 ${today.length} 条指派给你的任务：${names}。`);
  }

  if (overdue.length > 0) {
    const prefix = today.length === 0 ? "但" : "另外";
    const items = overdue.map((t) => {
      const name = t.title || "未命名";
      return isHighPriority(t.priority) ? `${name}（高优先级）` : name;
    });
    lines.push(
      `${prefix}有 ${overdue.length} 条逾期未完成，需要重点处理：${items.join("、")}，请尽快安排。`,
    );
  }

  if (upcoming.length > 0) {
    const items = upcoming
      .slice(0, 3)
      .map((t) => `${relDateLabel(timezone, t.start_at!, localDate)}「${t.title || "未命名"}」`);
    lines.push(`未来几天有排期：${items.join("，")}。`);
  }

  if (unscheduled.length === 0) {
    lines.push("目前没有未排期的任务。");
  } else {
    const names = unscheduled.slice(0, 10).map((t) => t.title || "未命名").join("、");
    lines.push(`目前有 ${unscheduled.length} 条未排期的任务：${names}。`);
  }

  return lines.join("\n");
}

async function buildSummaryForUser(params: {
  admin: ReturnType<typeof createAdminClient>;
  userId: string;
  spaceId?: string;
  timezone: string;
}) {
  const { localDate, startIso, endIso } = dayBounds(params.timezone);
  let query = params.admin
    .from("todos")
    .select(
      "id, title, priority, status, start_at, end_at, due_at, space_id, todo_assignees!inner(user_id)",
    )
    .eq("todo_assignees.user_id", params.userId)
    .neq("status", "done");

  if (params.spaceId) query = query.eq("space_id", params.spaceId);

  const { data: todos, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (todos || []) as SumTodo[];
  const today = rows.filter((t) => {
    if (t.start_at && t.start_at <= endIso && (t.end_at || t.start_at) >= startIso) {
      return true;
    }
    if (t.due_at && t.due_at >= startIso && t.due_at <= endIso) return true;
    return false;
  });

  // 逾期：排期/截止落在今天之前且未完成（不含今天）。这是最需要提醒的部分。
  const overdue = rows.filter((t) => {
    const past = t.start_at
      ? t.start_at < startIso
      : t.due_at
      ? t.due_at < startIso
      : false;
    return past;
  });

  // 未来已排期（今天之后），给一个最近预告，避免"什么都没有"的错觉
  const upcoming = rows.filter((t) => t.start_at && t.start_at > endIso);

  const unscheduled = rows.filter((t) => !t.start_at);

  // 排序：今天/未来按时间升序，逾期按优先级降序（高优在前）
  const byTime = (a: SumTodo, b: SumTodo) =>
    (a.start_at || a.due_at || "").localeCompare(b.start_at || b.due_at || "");
  today.sort(byTime);
  upcoming.sort(byTime);
  overdue.sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));

  const text = buildSummaryText({
    localDate,
    timezone: params.timezone,
    today,
    overdue,
    upcoming,
    unscheduled,
  });

  return {
    localDate,
    text,
    todayCount: today.length,
    overdueCount: overdue.length,
    todos: today,
  };
}

export const dailySummaryRouter = Router();

/** 登录用户手动拉取自己的今日摘要，并写入 notifications */
dailySummaryRouter.post("/daily-summary", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = z
      .object({
        space_id: z.string().uuid().optional(),
        timezone: z.string().optional(),
      })
      .parse(req.body || {});

    const admin = createAdminClient();
    if (body.space_id) {
      await assertSpaceMember(admin, body.space_id, auth.user.id);
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("timezone")
      .eq("id", auth.user.id)
      .maybeSingle();

    const timezone = body.timezone || profile?.timezone || "Asia/Shanghai";
    const summary = await buildSummaryForUser({
      admin,
      userId: auth.user.id,
      spaceId: body.space_id,
      timezone,
    });

    const { data: notification, error } = await admin
      .from("notifications")
      .insert({
        user_id: auth.user.id,
        space_id: body.space_id || null,
        type: "daily_summary",
        title: `${summary.localDate} 今日摘要`,
        body: summary.text,
        payload: { todo_ids: summary.todos.map((t) => t.id) },
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    if (body.space_id) {
      await admin.from("ai_actions").insert({
        space_id: body.space_id,
        user_id: auth.user.id,
        action_type: "daily_summary",
        payload: { text: summary.text, local_date: summary.localDate },
        result_todo_ids: summary.todos.map((t) => t.id),
        status: "applied",
      });
    }

    res.json({
      notification_id: notification.id,
      date: summary.localDate,
      summary: summary.text,
      today_count: summary.todayCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

/** Railway Cron：为所有用户生成摘要（需 x-cron-secret） */
dailySummaryRouter.post(
  "/jobs/daily-summary",
  requireCronSecret,
  async (_req, res) => {
    try {
      const admin = createAdminClient();
      const { data: profiles, error } = await admin
        .from("profiles")
        .select("id, timezone");
      if (error) throw new Error(error.message);

      let created = 0;
      for (const p of profiles || []) {
        const summary = await buildSummaryForUser({
          admin,
          userId: p.id,
          timezone: p.timezone || "Asia/Shanghai",
        });
        if (summary.todayCount === 0 && summary.overdueCount === 0 && summary.text.length < 5) continue;

        const { error: nErr } = await admin.from("notifications").insert({
          user_id: p.id,
          type: "daily_summary",
          title: `${summary.localDate} 今日摘要`,
          body: summary.text,
          payload: { todo_ids: summary.todos.map((t) => t.id) },
        });
        if (!nErr) created += 1;
      }

      res.json({ ok: true, created });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  },
);
