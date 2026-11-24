/**
 * 日程占用计算（前后端语义统一的核心）
 *
 * 规则与数据库函数 check_schedule_conflicts 保持一致：
 * - 有指派 → 占用者 = 全部被指派人
 * - 无指派 → 占用者 = 创建人（否则「自己创建的、没指派的」任务永远不参与冲突检测）
 *
 * 历史 bug：ai-conflict-suggest 曾用 todo_assignees.inner join 只取被指派任务，
 * 导致「未指派、创建人是我」的任务被整条过滤掉 → 明明重叠却报「未检测到冲突」。
 */

export type AssigneeRef = { user_id: string };

export type OccupancyTodo = {
  id: string;
  space_id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  status?: string | null;
  creator_id?: string | null;
  is_all_day?: boolean | null;
  priority?: string | null;
  due_at?: string | null;
  description?: string | null;
  todo_assignees?: AssigneeRef[] | null;
};

export type Interval = { start: number; end: number };

export type BusyEntry = Interval & {
  todo_id: string;
  title: string;
  user_id: string;
};

/** 缺少 end_at 时的兜底时长 */
export const DEFAULT_DURATION_MS = 60 * 60 * 1000;

/**
 * 宽容解析后端返回的时间字符串。
 * 注意 Date.parse('2026-11-13T08:00:00+00') 在 V8 里是 NaN（不能省分钟冒号），
 * 直接用它会让整条任务被当成「无时间段」而漏掉冲突。
 */
export function parseTime(value: string | null | undefined): number {
  if (!value) return NaN;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:([+-]\d{2}):?(\d{2})?|Z)?$/.exec(
      value.trim(),
    );
  if (!m) return NaN;
  const offset = m[3] ? `${m[3]}:${m[4] ?? "00"}` : "Z";
  return Date.parse(`${m[1]}T${m[2]}${offset}`);
}

export function occupantsOf(todo: OccupancyTodo): string[] {
  const ids = (todo.todo_assignees ?? [])
    .map((a) => a.user_id)
    .filter((id): id is string => Boolean(id));
  if (ids.length > 0) return [...new Set(ids)];
  return todo.creator_id ? [todo.creator_id] : [];
}

export function intervalOf(todo: OccupancyTodo): Interval | null {
  if (!todo.start_at) return null;
  const start = parseTime(todo.start_at);
  if (Number.isNaN(start)) return null;
  const rawEnd = parseTime(todo.end_at);
  const end =
    Number.isNaN(rawEnd) || rawEnd <= start ? start + DEFAULT_DURATION_MS : rawEnd;
  return { start, end };
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && a.end > b.start;
}

export function isActive(todo: OccupancyTodo): boolean {
  return todo.status !== "done";
}

/** 构建忙时间轴（每个占用者单独一条） */
export function buildBusy(
  todos: OccupancyTodo[],
  excludeIds: Set<string> = new Set(),
): BusyEntry[] {
  const out: BusyEntry[] = [];
  for (const todo of todos) {
    if (!isActive(todo) || excludeIds.has(todo.id)) continue;
    const iv = intervalOf(todo);
    if (!iv) continue;
    for (const uid of occupantsOf(todo)) {
      out.push({
        ...iv,
        todo_id: todo.id,
        title: todo.title,
        user_id: uid,
      });
    }
  }
  return out;
}

/** 某组占用者在给定时间段内的冲突项（去重，最多返回 limit 条） */
export function conflictsAt(
  busy: BusyEntry[],
  userIds: string[],
  iv: Interval,
  ignoreTodoIds: Set<string> = new Set(),
  limit = 5,
): BusyEntry[] {
  const seen = new Set<string>();
  const out: BusyEntry[] = [];
  for (const entry of busy) {
    if (!userIds.includes(entry.user_id)) continue;
    if (ignoreTodoIds.has(entry.todo_id)) continue;
    if (seen.has(entry.todo_id)) continue;
    if (!overlaps(entry, iv)) continue;
    seen.add(entry.todo_id);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** 两两冲突对（同一占用者时段重叠），可按 userId 限定只算某人 */
export function findConflictPairs(
  todos: OccupancyTodo[],
  userId?: string,
): Array<{ a: string; b: string }> {
  const list = todos
    .filter(isActive)
    .map((todo) => ({
      todo,
      iv: intervalOf(todo),
      owners: occupantsOf(todo),
    }))
    .filter((x): x is { todo: OccupancyTodo; iv: Interval; owners: string[] } =>
      Boolean(x.iv),
    );

  const pairs: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const x = list[i];
      const y = list[j];
      if (!overlaps(x.iv, y.iv)) continue;
      const shared = x.owners.filter((id) => y.owners.includes(id));
      if (shared.length === 0) continue;
      if (userId && !shared.includes(userId)) continue;
      pairs.push({ a: x.todo.id, b: y.todo.id });
    }
  }
  return pairs;
}

/* -------------------------------------------------------------------------- */
/* 空闲槽搜索：给排期用，保证新排入的时段与已有安排不重叠                        */
/* -------------------------------------------------------------------------- */

const STEP_MS = 15 * 60 * 1000;

function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

/** 目标时区下的「当天分钟数」与日期键（YYYY-MM-DD） */
function localClock(
  ms: number,
  timeZone: string,
): { minuteOfDay: number; dayKey: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    minuteOfDay: hour * 60 + minute,
    dayKey: `${get("year")}-${String(month).padStart(2, "0")}-${String(
      day,
    ).padStart(2, "0")}`,
  };
}

export type FreeSlotParams = {
  busy: BusyEntry[];
  userIds: string[];
  durationMs: number;
  /** 期望起始时间（ms） */
  from: number;
  workdayStart: string;
  workdayEnd: string;
  timezone: string;
  horizonDays?: number;
  /** 已在本次批量中排过的任务 id，同样视为占用 */
  ignoreTodoIds?: Set<string>;
};

/**
 * 从 from 起向后找最早的不冲突工作时段（15 分钟步进）。
 * 找不到返回 null。
 */
export function findFreeSlot(params: FreeSlotParams): Interval | null {
  const {
    busy,
    userIds,
    durationMs,
    workdayStart,
    workdayEnd,
    timezone,
    horizonDays = 14,
    ignoreTodoIds = new Set<string>(),
  } = params;

  const startMin = parseHm(workdayStart);
  const endMin = parseHm(workdayEnd);

  const nowCeil = Math.ceil(Date.now() / STEP_MS) * STEP_MS;
  const anchor = Number.isFinite(params.from) ? params.from : nowCeil;
  let cursor = Math.max(anchor, nowCeil);
  // 对齐到 15 分钟网格
  cursor = Math.ceil(cursor / STEP_MS) * STEP_MS;

  const maxIterations = Math.max(1, horizonDays) * 96;
  for (let i = 0; i < maxIterations; i++) {
    const start = cursor + i * STEP_MS;
    const end = start + durationMs;
    const conflict = conflictsAt(busy, userIds, { start, end }, ignoreTodoIds, 1);
    if (conflict.length > 0) {
      // 直接跳到冲突结束，省时间
      const resume = conflict[0].end;
      if (resume > start + STEP_MS) {
        const skipped = Math.floor((resume - start) / STEP_MS);
        i += Math.max(0, skipped - 1);
      }
      continue;
    }

    if (startMin >= 0 && endMin > startMin) {
      const s = localClock(start, timezone);
      const e = localClock(end, timezone);
      const withinSameDay = s.dayKey === e.dayKey;
      const fits =
        withinSameDay && s.minuteOfDay >= startMin && e.minuteOfDay <= endMin;
      if (!fits) continue;
    }

    return { start, end };
  }
  return null;
}

export function formatInTz(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}
