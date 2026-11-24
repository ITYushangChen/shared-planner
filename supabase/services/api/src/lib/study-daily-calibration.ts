/**
 * 功能 B：试水期 → 自动校准每日学习量
 *
 * 语义（用户拍板）：
 *  - 试水期 = apply 所在自然周（周一~周日）；期间照常按既定每日时长排块、推卡，不改任何东西。
 *  - 系统靠 todos.completed_at（已由触发器兜底写入）记录「每个学习块在哪天完成」。
 *  - 试水期过后（下周一）系统算「上一自然周平均每天真实完成多少」，作为该书新的每日学习量上限。
 *  - 然后对「已 apply、未完成、scheduled_start 在未来」的学习块按新上限重新铺时间。
 *  - 每本书（每个 study_plan）各一个独立上限，互不共享。
 *
 * 口径（用户选择）：
 *  - 平均 = 上一自然周完成的「计划分钟数」总和 / 7（自然日，不是只除有学习安排的日期）。
 *  - 完成判定 = todos.status = 'done'，且 todos.completed_at 落在上一自然周内（按用户时区）。
 *
 * 防重复：校准结果写进 study_plans.params.daily_cap_calibrated_week（上一自然周的周一日期 key），
 *   同一个自然周只校准一次；每天跑 job 时若已标记则跳过。
 *
 * 复用 packStudyPlan（确定性装箱，不烧 AI）：只换 dailyMinutesCap，重排未来块。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBusy, type OccupancyTodo } from "./occupancy";
import { listUserSpaceIds } from "./space";
import {
  addDays,
  packStudyPlan,
  todayInTz,
  weekdayOf,
  zonedToUtc,
  type StudyUnit,
} from "./study-packing";

/** 校准后的每日上限下限：低于它几乎排不进任何块，直接保底 */
export const MIN_DAILY_CAP_MINUTES = 15;
/** 校准结果四舍五入到这个网格（分钟） */
export const CAP_STEP_MINUTES = 5;

export type StudyPlanRow = {
  id: string;
  book_title: string;
  space_id: string;
  params: Record<string, unknown>;
};

export type CalibrationPlanResult = {
  plan_id: string;
  space_id: string;
  book_title: string;
  last_week_done_minutes: number;
  avg_per_day: number;
  old_cap: number | null;
  new_cap: number | null;
  rescheduled: number;
  skipped_reason: "already" | "no_data" | null;
};

export type CalibrationReport = {
  week_key: string;
  checked: number;
  calibrated: number;
  plans: CalibrationPlanResult[];
};

function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

/** 四舍五入到 step 分钟网格 */
export function roundToStep(minutes: number, step = CAP_STEP_MINUTES): number {
  return Math.round(minutes / step) * step;
}

/**
 * 上一自然周（相对「今天」）的：
 *  - mondayKey：该周周一日期 YYYY-MM-DD（同时用作校准标记）
 *  - startIso / endIso：该周在用户时区下的 UTC 起止（[周一 00:00, 下周一 00:00)）
 */
export function computeLastNaturalWeek(
  timezone: string,
  todayKey: string,
): { mondayKey: string; startIso: string; endIso: string } {
  const dow = weekdayOf(todayKey); // 1=周一 … 7=周日
  const thisMonday = addDays(todayKey, -(dow - 1));
  const lastMonday = addDays(thisMonday, -7);
  const startMs = zonedToUtc(lastMonday, "00:00", timezone);
  const endMs = zonedToUtc(thisMonday, "00:00", timezone);
  return {
    mondayKey: lastMonday,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/**
 * 由上一自然周的完成量算新上限：
 *  newCap = round( Σ完成分钟 / 7 )，下限 MIN_DAILY_CAP_MINUTES，上界每日窗口长度。
 *  Σ完成分钟 <= 0 时返回 null（无数据，不校准）。
 */
export function computeNewDailyCap(
  totalDoneMinutes: number,
  windowMinutes: number,
): number | null {
  if (totalDoneMinutes <= 0) return null;
  const avg = totalDoneMinutes / 7;
  const cap = Math.min(
    Math.max(roundToStep(avg), MIN_DAILY_CAP_MINUTES),
    windowMinutes,
  );
  return cap;
}

/* -------------------------------------------------------------------------- */
/* 单计划校准 + 重排                                                           */
/* -------------------------------------------------------------------------- */

type ItemWithTodo = {
  id: string;
  seq: number;
  title: string;
  minutes: number;
  pages: number | null;
  difficulty: number | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  todo_id: string | null;
  status: string;
};

async function calibrateOnePlan(
  admin: SupabaseClient,
  plan: StudyPlanRow,
  week: { mondayKey: string; startIso: string; endIso: string },
  userId: string,
  timezone: string,
  busy: ReturnType<typeof buildBusy>,
  nowMs: number,
): Promise<CalibrationPlanResult> {
  const params = (plan.params ?? {}) as Record<string, unknown>;

  // 已经校准过这个自然周 → 跳过
  if (params.daily_cap_calibrated_week === week.mondayKey) {
    return {
      plan_id: plan.id,
      space_id: plan.space_id,
      book_title: plan.book_title,
      last_week_done_minutes: 0,
      avg_per_day: 0,
      old_cap: (params.daily_minutes_cap as number) ?? null,
      new_cap: null,
      rescheduled: 0,
      skipped_reason: "already",
    };
  }

  const dailyStart = String(params.daily_start ?? "20:00");
  const dailyEnd = String(params.daily_end ?? "21:30");
  const windowMinutes = Math.max(0, parseHm(dailyEnd) - parseHm(dailyStart));

  // 拉该计划全部学习块（含 todo_id 非空的）
  const { data: itemRows, error: itemErr } = await admin
    .from("study_plan_items")
    .select(
      "id, seq, title, minutes, pages, difficulty, scheduled_start, scheduled_end, todo_id, status",
    )
    .eq("plan_id", plan.id)
    .not("todo_id", "is", null)
    .order("seq", { ascending: true });
  if (itemErr) throw new Error(`study_plan_items 查询失败: ${itemErr.message}`);
  const items = (itemRows ?? []) as ItemWithTodo[];

  // 拿关联待办的完成状态与完成时间
  const todoIds = [
    ...new Set(items.map((i) => i.todo_id).filter(Boolean)),
  ] as string[];
  const doneAt = new Map<string, string>();
  if (todoIds.length > 0) {
    const { data: todoRows } = await admin
      .from("todos")
      .select("id, status, completed_at")
      .in("id", todoIds);
    for (const t of (todoRows ?? []) as Array<{
      id: string;
      status: string;
      completed_at: string | null;
    }>) {
      if (t.status === "done") doneAt.set(t.id, t.completed_at ?? "");
    }
  }

  // 上一自然周内实际完成的分钟总和
  const weekStartMs = Date.parse(week.startIso);
  const weekEndMs = Date.parse(week.endIso);
  let lastWeekDoneMinutes = 0;
  for (const it of items) {
    if (!it.todo_id) continue;
    const ca = doneAt.get(it.todo_id);
    if (!ca) continue; // 未完成
    const t = Date.parse(ca);
    if (Number.isFinite(t) && t >= weekStartMs && t < weekEndMs) {
      lastWeekDoneMinutes += Number(it.minutes) || 0;
    }
  }

  const newCap = computeNewDailyCap(lastWeekDoneMinutes, windowMinutes);
  if (newCap === null) {
    // 上周完全没有完成数据：保留原值，只做「不校准」，不写标记（下次可能又有数据）
    return {
      plan_id: plan.id,
      space_id: plan.space_id,
      book_title: plan.book_title,
      last_week_done_minutes: 0,
      avg_per_day: 0,
      old_cap: (params.daily_minutes_cap as number) ?? null,
      new_cap: null,
      rescheduled: 0,
      skipped_reason: "no_data",
    };
  }

  // 未来未完成的块 → 重排（scheduled_start >= now，且未完成）
  const futureItems = items.filter((it) => {
    if (!it.todo_id) return false;
    if (doneAt.has(it.todo_id)) return false; // 已完成不动
    if (!it.scheduled_start) return false;
    const s = Date.parse(it.scheduled_start);
    return Number.isFinite(s) && s >= nowMs;
  });

  const units: StudyUnit[] = futureItems.map((it) => ({
    seq: it.seq,
    title: it.title,
    chapter_no: null,
    minutes: Number(it.minutes),
    pages: it.pages ?? null,
    difficulty: it.difficulty ?? null,
  }));

  const today = todayInTz(timezone, nowMs);

  // 排除本计划所有学习块的待办（否则它们当前的 scheduled 时间会挡住自己重排）
  const selfTodoIds = new Set(
    items.map((i) => i.todo_id).filter(Boolean) as string[],
  );
  const filteredBusy = busy.filter((b) => !selfTodoIds.has(b.todo_id));
  const packed = packStudyPlan({
    units,
    startDate: today,
    weekdays: Array.isArray(params.weekdays)
      ? (params.weekdays as number[])
      : [1, 2, 3, 4, 5],
    dailyStart,
    dailyEnd,
    dailyMinutesCap: newCap,
    timezone,
    busy: filteredBusy,
    userIds: [userId],
    deadline: (params.deadline as string) || null,
    now: nowMs,
  });

  // seq → item 映射（同一计划内 seq 唯一）
  const bySeq = new Map<number, ItemWithTodo>();
  for (const it of futureItems) {
    if (!bySeq.has(it.seq)) bySeq.set(it.seq, it);
  }

  let rescheduled = 0;
  for (const slot of packed.slots) {
    const it = bySeq.get(slot.seq);
    if (!it || !it.todo_id) continue;
    const newStart = new Date(slot.start_ms).toISOString();
    const newEnd = new Date(slot.end_ms).toISOString();

    const { error: upItem } = await admin
      .from("study_plan_items")
      .update({ scheduled_start: newStart, scheduled_end: newEnd })
      .eq("id", it.id);
    if (upItem) throw new Error(`回写 study_plan_items 失败: ${upItem.message}`);

    const { error: upTodo } = await admin
      .from("todos")
      .update({ start_at: newStart, end_at: newEnd })
      .eq("id", it.todo_id);
    if (upTodo) throw new Error(`回写 todos 失败: ${upTodo.message}`);

    rescheduled += 1;
  }

  // 落库：新上限 + 校准标记
  const newParams = {
    ...params,
    daily_minutes_cap: newCap,
    daily_cap_calibrated_week: week.mondayKey,
  };
  const { error: upPlan } = await admin
    .from("study_plans")
    .update({ params: newParams, updated_at: new Date().toISOString() })
    .eq("id", plan.id);
  if (upPlan) throw new Error(`回写 study_plans 失败: ${upPlan.message}`);

  return {
    plan_id: plan.id,
    space_id: plan.space_id,
    book_title: plan.book_title,
    last_week_done_minutes: lastWeekDoneMinutes,
    avg_per_day: Math.round((lastWeekDoneMinutes / 7) * 10) / 10,
    old_cap: (params.daily_minutes_cap as number) ?? null,
    new_cap: newCap,
    rescheduled,
    skipped_reason: null,
  };
}

/* -------------------------------------------------------------------------- */
/* 主入口：对该用户所有已 apply 的学习计划做一次校准                              */
/* -------------------------------------------------------------------------- */

export async function runDailyCalibration(
  admin: SupabaseClient,
  userId: string,
  now = Date.now(),
): Promise<CalibrationReport> {
  const { data: profile } = await admin
    .from("profiles")
    .select("timezone")
    .eq("id", userId)
    .maybeSingle();
  const timezone =
    (profile?.timezone as string | undefined) || "Asia/Shanghai";

  const todayKey = todayInTz(timezone, now);
  const week = computeLastNaturalWeek(timezone, todayKey);

  // 该用户已 apply 的计划（每本书一个）
  const { data: planRows, error: planErr } = await admin
    .from("study_plans")
    .select("id, book_title, space_id, params")
    .eq("user_id", userId)
    .eq("status", "applied")
    .order("created_at", { ascending: false });
  if (planErr) throw new Error(`study_plans 查询失败: ${planErr.message}`);
  const plans = (planRows ?? []) as StudyPlanRow[];

  if (plans.length === 0) {
    return { week_key: week.mondayKey, checked: 0, calibrated: 0, plans: [] };
  }

  // busy：该用户所有空间里已排期、未完成的日程（重排时避开）
  const spaceIds = await listUserSpaceIds(admin, userId);
  let busy: ReturnType<typeof buildBusy> = [];
  if (spaceIds.length > 0) {
    const { data: busyRows } = await admin
      .from("todos")
      .select(
        "id, space_id, title, priority, status, start_at, end_at, is_all_day, creator_id, todo_assignees(user_id)",
      )
      .in("space_id", spaceIds)
      .neq("status", "done")
      .not("start_at", "is", null);
    busy = buildBusy((busyRows ?? []) as unknown as OccupancyTodo[]);
  }

  const results: CalibrationPlanResult[] = [];
  for (const plan of plans) {
    results.push(
      await calibrateOnePlan(admin, plan, week, userId, timezone, busy, now),
    );
  }

  return {
    week_key: week.mondayKey,
    checked: results.length,
    calibrated: results.filter((r) => r.new_cap !== null).length,
    plans: results,
  };
}
