import { dayBounds, tzOffsetMs } from "./day-bounds";
import { signRescheduleAction, signTodoAction } from "./card-sign";
import { listUserSpaceIds } from "./space";
import type { OccupancyTodo } from "./occupancy";
import type { createAdminClient } from "./supabase";

/**
 * 飞书「今日任务安排」卡片：数据装配 + 卡片拼装。
 *
 * 抽成公共模块的原因：推送路由（/jobs/daily-plan-push）和卡片按钮回调路由
 * （/feishu/card-callback）都要用它 —— 回调点完必须能用同一套逻辑重建卡片回显 ✅。
 */

export const TODO_SELECT =
  "id, space_id, title, priority, status, start_at, end_at, due_at, duration_minutes, creator_id, todo_assignees(user_id)";

export type PlanTodo = OccupancyTodo & { duration_minutes?: number | null };

/** HH:MM 格式化（按用户时区） */
export function hmInTz(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** yyyy-MM-dd HH:mm 格式化（按用户时区）——picker_datetime 的 initial_datetime 用 */
export function dtInTz(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) =>
    (parts.find((p) => p.type === t)?.value ?? "").padStart(2, "0");
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/**
 * 把飞书 picker_datetime 回调回传的选中值转成 UTC ISO。
 *
 * 回传格式 `yyyy-MM-dd HH:mm +0800`（含时区偏移，也可能不带偏移）。
 * 带偏移时直接用偏移算 UTC；不带偏移时退回用户时区（tzOffsetMs 反推）。
 * 解析失败返回 null。
 */
export function parsePickerDatetime(
  option: string,
  timezone: string,
): string | null {
  const m = option
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?(?: ([+-]\d{2}):?(\d{2}))?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = m[6] ? Number(m[6]) : 0;
  const off = m[7] ? `${m[7]}${m[8] ?? "00"}` : "";

  let utcMs: number;
  if (off) {
    const sign = off[0] === "+" ? 1 : -1;
    const offMinutes = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
    utcMs = Date.UTC(y, mo, d, hh, mi, ss) - offMinutes * 60000;
  } else {
    const guess = Date.UTC(y, mo, d, hh, mi, ss);
    utcMs = guess - tzOffsetMs(guess, timezone);
  }

  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

const PRIORITY_LABEL: Record<string, string> = {
  high: "🔴高",
  medium: "🟡中",
  low: "🟢低",
};

/** 分钟 → 「2 小时 15 分」/「45 分钟」 */
export function fmtMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} 分钟`;
  if (rest === 0) return `${h} 小时`;
  return `${h} 小时 ${rest} 分`;
}

export type StudyItem = {
  id: string;
  plan_id: string;
  seq: number;
  title: string;
  minutes: number;
  scheduled_start: string | null;
  scheduled_end: string | null;
  todo_id: string | null;
  status: string;
};

/** 单个学习计划当天的摘要 */
export type StudyPlanDigest = {
  planId: string;
  bookTitle: string;
  todayItems: Array<StudyItem & { done: boolean }>;
  totalUnits: number;
  doneUnits: number;
  /** 计划时间已过但还没完成的学习块 */
  overdueUnits: number;
  overdueMinutes: number;
};

/**
 * 拉目标用户的「已生成待办」学习计划，算今日学习块与落后情况。
 *
 * 口径（与前端「我的计划」一致）：
 *  - 进度以 todos.status 为准（study_plan_items.status 不随待办完成实时回写）
 *  - 落后 = 计划结束时间已过（scheduled_end < now）且待办未完成
 *  - 只统计 apply 过的块（todo_id 非空）
 */
export async function loadStudyDigest(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  opts: { startIso: string; endIso: string; nowMs: number },
): Promise<StudyPlanDigest[]> {
  const { data: plans } = await admin
    .from("study_plans")
    .select("id, book_title, created_at")
    .eq("user_id", userId)
    .eq("status", "applied")
    .order("created_at", { ascending: false })
    .limit(10);

  const planRows = (plans ?? []) as Array<{ id: string; book_title: string }>;
  if (planRows.length === 0) return [];

  const { data: itemRows } = await admin
    .from("study_plan_items")
    .select(
      "id, plan_id, seq, title, minutes, scheduled_start, scheduled_end, todo_id, status",
    )
    .in(
      "plan_id",
      planRows.map((p) => p.id),
    )
    .not("todo_id", "is", null)
    .order("scheduled_start", { ascending: true });

  const items = (itemRows ?? []) as StudyItem[];
  if (items.length === 0) return [];

  // 待办完成状态
  const todoIds = [
    ...new Set(items.map((i) => i.todo_id).filter(Boolean)),
  ] as string[];
  const doneSet = new Set<string>();
  if (todoIds.length > 0) {
    const { data: todoRows } = await admin
      .from("todos")
      .select("id, status")
      .in("id", todoIds);
    for (const t of (todoRows ?? []) as Array<{ id: string; status: string }>) {
      if (t.status === "done") doneSet.add(t.id);
    }
  }

  const isDone = (i: StudyItem) => !!i.todo_id && doneSet.has(i.todo_id);
  const startMs = Date.parse(opts.startIso);
  const endMs = Date.parse(opts.endIso);

  return planRows.map((p) => {
    const mine = items.filter((i) => i.plan_id === p.id);
    const todayItems = mine
      .filter((i) => {
        if (!i.scheduled_start) return false;
        const s = Date.parse(i.scheduled_start);
        return s >= startMs && s <= endMs;
      })
      .map((i) => ({ ...i, done: isDone(i) }));

    const overdue = mine.filter((i) => {
      if (isDone(i)) return false;
      if (!i.scheduled_end) return false;
      const e = Date.parse(i.scheduled_end);
      return Number.isFinite(e) && e < opts.nowMs;
    });

    return {
      planId: p.id,
      bookTitle: p.book_title,
      todayItems,
      totalUnits: mine.length,
      doneUnits: mine.filter(isDone).length,
      overdueUnits: overdue.length,
      overdueMinutes: overdue.reduce((s, i) => s + (Number(i.minutes) || 0), 0),
    };
  });
}

/**
 * 一行「内容 + 完成/撤销按钮」。
 *
 * 卡片是 1.0 结构，逐行按钮用 column_set 摆：左列文本（weighted），
 * 右列按钮（auto 宽度）。按钮 value 带 HMAC 签名，回调侧验签后才会写库。
 *
 * value 里的 `d` 是这张卡片所属的本地日期：回调侧要求 `d` 等于用户的「今天」，
 * 于是昨天/前天的卡片点下去只会提示过期，不会改状态。
 */
function actionRow(
  text: string,
  action: "done" | "undo",
  todoId: string,
  localDate: string,
) {
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 5,
        vertical_align: "center",
        elements: [
          { tag: "div", text: { tag: "lark_md", content: text } },
        ],
      },
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: action === "done" ? "完成" : "撤销",
            },
            type: "default",
            value: {
              a: action,
              t: todoId,
              d: localDate,
              s: signTodoAction(action, todoId, localDate),
            },
          },
        ],
      },
    ],
  };
}

/**
 * 一行「改期」：开始时间选择器 + 结束时间选择器。
 *
 * 飞书 picker_datetime 直接嵌套在 column（分栏）里是允许的；用户选中后
 * 选中值回传在回调的 event.action.option（格式 "yyyy-MM-dd HH:mm +0800"），
 * 自定义数据回传在 event.action.value。这里用 value 里的 `f` 区分是改
 * 开始还是结束，`s` 是 HMAC 签名（改期动作串 mv:start / mv:end）。
 */
function timeRow(
  startIso: string | null,
  endIso: string | null,
  todoId: string,
  localDate: string,
  timezone: string,
) {
  const picker = (f: "start" | "end", iso: string | null) => ({
    tag: "picker_datetime",
    name: `${f}_${todoId}`,
    width: "fill",
    initial_datetime: iso ? dtInTz(iso, timezone) : undefined,
    placeholder: { tag: "plain_text", content: f === "start" ? "开始" : "结束" },
    value: {
      a: "mv",
      t: todoId,
      d: localDate,
      f,
      s: signRescheduleAction(f, todoId, localDate),
    },
  });
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 5,
        vertical_align: "center",
        elements: [
          {
            tag: "div",
            text: { tag: "lark_md", content: "🕒 改期" },
          },
        ],
      },
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [picker("start", startIso)],
      },
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [picker("end", endIso)],
      },
    ],
  };
}

export type BuildCardParams = {
  localDate: string;
  timezone: string;
  today: PlanTodo[];
  future: PlanTodo[];
  skippedCount: number;
  study?: StudyPlanDigest[];
  webBaseUrl?: string;
  /** 按钮回调后重建卡片：不显示「已自动排入未来」与跳过备注 */
  rebuild?: boolean;
};

export function buildCard(params: BuildCardParams): Record<string, unknown> {
  const { localDate, timezone, today, future, skippedCount, study, webBaseUrl, rebuild } =
    params;

  const elements: Array<Record<string, unknown>> = [];

  // ---- 今日学习（学习计划排出的块）----
  const todayStudy = (study ?? []).filter((p) => p.todayItems.length > 0);
  if (todayStudy.length > 0) {
    const lines: string[] = [];
    for (const p of todayStudy) lines.push(`**《${p.bookTitle}》**`);
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `📚 **今日学习**\n${lines.join("\n")}` },
    });
    for (const p of todayStudy) {
      for (const it of p.todayItems) {
        const start = it.scheduled_start
          ? hmInTz(it.scheduled_start, timezone)
          : "--:--";
        const end = it.scheduled_end ? hmInTz(it.scheduled_end, timezone) : start;
        const text = `${it.done ? "✅" : "◻️"} **${start}–${end}** ${it.title}（${
          it.minutes
        } 分钟）`;
        const tid = it.todo_id;
        if (tid) {
          elements.push(actionRow(text, it.done ? "undo" : "done", tid, localDate));
          elements.push(
            timeRow(it.scheduled_start, it.scheduled_end, tid, localDate, timezone),
          );
        } else {
          elements.push({
            tag: "div",
            text: { tag: "lark_md", content: text },
          });
        }
      }
    }
    elements.push({ tag: "hr" });
  }

  if (today.length === 0) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: "今天没有已排期的任务。⛅" },
    });
  } else {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: "🕘 **今日日程**" },
    });
    for (const t of today) {
      const start = t.start_at ? hmInTz(t.start_at, timezone) : "--:--";
      const end = t.end_at ? hmInTz(t.end_at, timezone) : start;
      const p = PRIORITY_LABEL[t.priority ?? ""] ?? "";
      const done = t.status === "done";
      const text = `${done ? "✅" : "◻️"} **${start}–${end}**  ${t.title}${
        p ? ` ${p}` : ""
      }`;
      elements.push(actionRow(text, done ? "undo" : "done", t.id, localDate));
      elements.push(timeRow(t.start_at, t.end_at, t.id, localDate, timezone));
    }
  }

  if (!rebuild && future.length > 0) {
    const names = future.map((t) => t.title).join("、");
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `📌 已自动排入未来空闲时段：${names}`,
      },
    });
  }

  // ---- 进度预警（落后 = 计划时间已过但没完成）----
  const studyAll = study ?? [];
  if (studyAll.length > 0) {
    const warnLines: string[] = [];
    for (const p of studyAll) {
      const pct =
        p.totalUnits > 0 ? Math.round((p.doneUnits / p.totalUnits) * 100) : 0;
      if (p.overdueUnits > 0) {
        warnLines.push(
          `⚠️ **《${p.bookTitle}》落后 ${p.overdueUnits} 块**（约 ${fmtMinutes(
            p.overdueMinutes,
          )}）· 进度 ${p.doneUnits}/${p.totalUnits} 块（${pct}%）`,
        );
      } else {
        warnLines.push(
          `✅ 《${p.bookTitle}》无落后 · 进度 ${p.doneUnits}/${p.totalUnits} 块（${pct}%）`,
        );
      }
    }
    const behind = studyAll.filter((p) => p.overdueUnits > 0);
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `${
          behind.length > 0 ? "⏰ **进度预警**" : "📈 **学习进度**"
        }\n${warnLines.join("\n")}${
          behind.length > 0
            ? "\n今晚先把落后的补上，或去「学习」页调整每日时长重排。"
            : ""
        }`,
      },
    });
  }

  if (!rebuild && skippedCount > 0) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `${skippedCount} 条任务因未来 14 天无空闲时段未能排入`,
        },
      ],
    });
  }

  // ---- 跳转按钮（有学习计划时给，方便直接去核对进度）----
  if (studyAll.length > 0 && webBaseUrl) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "打开学习计划" },
          type: "primary",
          url: `${webBaseUrl.replace(/\/$/, "")}/app/study`,
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: `📋 今日任务安排 · ${localDate}` },
    },
    elements,
  };
}

/**
 * 读用户时区（缺省 Asia/Shanghai）。
 *
 * 回调侧要按用户时区算「今天」来判定卡片是否过期，必须和推送侧口径一致，
 * 所以和 loadPlanCardSnapshot 共用这一个函数。
 */
export async function getUserTimezone(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<string> {
  const { data: profile } = await admin
    .from("profiles")
    .select("timezone")
    .eq("id", userId)
    .maybeSingle();
  return (profile?.timezone as string | undefined) || "Asia/Shanghai";
}

/**
 * 回调后重建卡片用：读用户时区 → 今日窗口 → 今日待办（含已完成）
 * → 学习摘要。与推送路由的读取口径保持一致，只是不涉及自动排程写库。
 */
export async function loadPlanCardSnapshot(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<{
  localDate: string;
  timezone: string;
  today: PlanTodo[];
  study: StudyPlanDigest[];
}> {
  const timezone = await getUserTimezone(admin, userId);
  const { localDate, startIso, endIso } = dayBounds(timezone);

  const spaceIds = await listUserSpaceIds(admin, userId);
  let today: PlanTodo[] = [];
  if (spaceIds.length > 0) {
    const { data } = await admin
      .from("todos")
      .select(TODO_SELECT)
      .in("space_id", spaceIds)
      .not("start_at", "is", null);
    const rows = (data ?? []) as PlanTodo[];
    today = rows.filter((t) => {
      if (!t.start_at) return false;
      return t.start_at <= endIso && (t.end_at || t.start_at) >= startIso;
    });
    today.sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? ""));
  }

  const study = await loadStudyDigest(admin, userId, {
    startIso,
    endIso,
    nowMs: Date.now(),
  });

  return { localDate, timezone, today, study };
}
