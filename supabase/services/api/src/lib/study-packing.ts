/**
 * 学习计划装箱算法（确定性，不依赖 AI）
 *
 * 输入：一串「学习单元」（标题 + 预估分钟）+ 每周可学日 + 每天可用窗口 + 已有日程占用
 * 输出：每个单元被放到哪一天几点到几点；放不下的原样退回，并给出缺口
 *
 * 为什么不用大模型排：让模型同时估时长又排日期，必然出现幻觉
 *（3 小时内容排进 45 分钟、日期跳空、忽略已有日程）。这里只做纯计算，
 * 同样的输入永远得到同样的计划，改参数重排毫秒级完成。
 *
 * 约束规则：
 *   1. 单元不跨空闲段（否则日历上会出现「中间被别的任务插一刀」的假连续块）
 *   2. 单元不跨天
 *   3. 每天总时长不超过 dailyMinutesCap（若设置）
 *   4. 窗口内已被日程占用的时段全部避开
 *   5. 起点不早于「现在」（四舍五入到 15 分钟网格）
 */

import { overlaps, type BusyEntry, type Interval } from "./occupancy";

const MINUTE_MS = 60 * 1000;
const STEP_MS = 15 * MINUTE_MS;

export type StudyUnit = {
  seq: number;
  title: string;
  chapter_no: number | null;
  minutes: number;
  /** 该块对应的教材页数（可校准量；老数据可能没有） */
  pages?: number | null;
  /** 难度 1~3（可校准量；老数据可能没有） */
  difficulty?: number | null;
};

export type PlacedUnit = StudyUnit & {
  start_ms: number;
  end_ms: number;
  date: string; // 计划所在本地日期 YYYY-MM-DD（便于前端按天分组）
};

export type PackDay = {
  date: string;
  minutes: number;
  units: number;
  /** 这一天窗口内被已有日程占掉的分钟数（用于提示「窗口太碎」） */
  busy_minutes: number;
};

export type DeadlineFit = {
  deadline: string;
  feasible: boolean;
  /** 截止日之前最多能学多少分钟 */
  capacity_minutes: number;
  /** 还差多少分钟才能学完（feasible 时为 0） */
  deficit_minutes: number;
  /** 按截止日前所剩的可用天数，每天需要额外多学多少分钟 */
  extra_per_day: number;
  /** 截止日前还剩几个可用学习日 */
  available_days: number;
};

export type PackResult = {
  slots: PlacedUnit[];
  unplaced: StudyUnit[];
  days: PackDay[];
  total_minutes: number;
  placed_minutes: number;
  placed_units: number;
  total_units: number;
  days_needed: number;
  start_date: string;
  end_date: string | null;
  daily_avg_minutes: number;
  deadline_fit: DeadlineFit | null;
  warnings: string[];
};

export type PackParams = {
  units: StudyUnit[];
  /** 起始本地日期 YYYY-MM-DD */
  startDate: string;
  /** 每周可学日，1=周一 … 7=周日 */
  weekdays: number[];
  /** 每天可用窗口 HH:MM */
  dailyStart: string;
  dailyEnd: string;
  /** 每天最多学多少分钟（不设则等于窗口长度） */
  dailyMinutesCap?: number | null;
  timezone: string;
  /** 已有日程（busy 需已按用户过滤，或同时传 userIds） */
  busy?: BusyEntry[];
  userIds?: string[];
  /** 最多向后找多少天，默认 400（一年） */
  horizonDays?: number;
  /** 截止日期 YYYY-MM-DD，用于算缺口 */
  deadline?: string | null;
  /** 空闲段短于这个分钟数视为不可用，默认 10 */
  minSegmentMinutes?: number;
  /** 「现在」的毫秒时间戳，默认 Date.now()。注入是为了让排期可复现、可自测 */
  now?: number;
};

/* -------------------------------------------------------------------------- */
/* 时区工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 某个 UTC 毫秒在该时区的「墙上时间」相对于 UTC 的偏移量（毫秒） */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string) => {
    const v = parts.find((p) => p.type === type)?.value ?? "0";
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  // hour12:false 在部分实现下会给出 24 表示午夜，取模兜底
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * 「某时区的本地日期 + HH:MM」→ UTC 毫秒。
 * 迭代两次以兼容夏令时边界（中国无 DST，一次即准）。
 */
export function zonedToUtc(
  dateKey: string,
  hm: string,
  timeZone: string,
): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mm] = hm.split(":").map(Number);
  if (![y, m, d, hh, mm].every((n) => Number.isFinite(n))) return NaN;

  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(guess, timeZone);
  ts = guess - tzOffsetMs(ts, timeZone);
  return ts;
}

/** 给本地日期键加天数（纯字符串运算，不受时区影响） */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const next = new Date(base + days * 86400000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/** 1=周一 … 7=周日 */
export function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
  return dow === 0 ? 7 : dow;
}

/** 当前时刻在目标时区的「今天」 */
export function todayInTz(timeZone: string, now = Date.now()): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(new Date(now));
}

/** 目标时区下某个 UTC 时刻的 HH:MM */
export function hmInTz(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/* -------------------------------------------------------------------------- */
/* 空闲段                                                                      */
/* -------------------------------------------------------------------------- */

/** 把 busy 从窗口里减掉，返回按时间升序的空闲段 */
export function freeSegments(
  window: Interval,
  busy: BusyEntry[],
  userIds: string[],
): Interval[] {
  const hits = busy
    .filter(
      (b) =>
        (userIds.length === 0 || userIds.includes(b.user_id)) &&
        overlaps(b, window),
    )
    .map((b) => ({
      start: Math.max(b.start, window.start),
      end: Math.min(b.end, window.end),
    }))
    .sort((a, b) => a.start - b.start);

  const out: Interval[] = [];
  let cursor = window.start;
  for (const h of hits) {
    if (h.start > cursor) out.push({ start: cursor, end: h.start });
    if (h.end > cursor) cursor = h.end;
  }
  if (cursor < window.end) out.push({ start: cursor, end: window.end });
  return out;
}

function ceilToStep(ms: number): number {
  return Math.ceil(ms / STEP_MS) * STEP_MS;
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

const EMPTY_RESULT_TAIL = {
  slots: [] as PlacedUnit[],
  unplaced: [] as StudyUnit[],
  days: [] as PackDay[],
  total_minutes: 0,
  placed_minutes: 0,
  placed_units: 0,
  total_units: 0,
  days_needed: 0,
  daily_avg_minutes: 0,
  deadline_fit: null,
  warnings: [] as string[],
};

export function packStudyPlan(params: PackParams): PackResult {
  const {
    dailyStart,
    dailyEnd,
    timezone,
    startDate,
    weekdays = [1, 2, 3, 4, 5, 6, 7],
    busy = [],
    userIds = [],
    horizonDays = 400,
    deadline = null,
    minSegmentMinutes = 10,
  } = params;

  const units = [...params.units]
    .filter((u) => u && u.minutes > 0 && u.title)
    .sort((a, b) => a.seq - b.seq);

  const totalUnits = units.length;
  const totalMinutes = units.reduce((s, u) => s + u.minutes, 0);

  const winStartMin = parseHm(dailyStart);
  const winEndMin = parseHm(dailyEnd);

  if (totalUnits === 0) {
    return {
      ...EMPTY_RESULT_TAIL,
      start_date: startDate,
      end_date: null,
      warnings: ["没有可排的学习单元"],
    };
  }
  if (winStartMin < 0 || winEndMin < 0 || winEndMin <= winStartMin) {
    return {
      ...EMPTY_RESULT_TAIL,
      unplaced: units,
      start_date: startDate,
      end_date: null,
      total_minutes: totalMinutes,
      total_units: totalUnits,
      warnings: [`每天可用窗口无效：${dailyStart}–${dailyEnd}`],
    };
  }
  const validWeekdays = weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5, 6, 7];
  const windowMinutes = winEndMin - winStartMin;
  const dailyCap =
    typeof params.dailyMinutesCap === "number" && params.dailyMinutesCap > 0
      ? Math.min(params.dailyMinutesCap, windowMinutes)
      : windowMinutes;

  const nowCeil = ceilToStep(params.now ?? Date.now());
  const slots: PlacedUnit[] = [];
  const days: PackDay[] = [];
  const warnings: string[] = [];
  let qi = 0;

  for (let d = 0; d < horizonDays && qi < units.length; d++) {
    const dateKey = addDays(startDate, d);
    if (!validWeekdays.includes(weekdayOf(dateKey))) continue;

    const winStart = zonedToUtc(dateKey, dailyStart, timezone);
    const winEnd = zonedToUtc(dateKey, dailyEnd, timezone);
    if (!Number.isFinite(winStart) || !Number.isFinite(winEnd)) continue;
    if (winEnd <= winStart) continue;

    // 今天已经过去的部分不排（首日尤其重要：不能把上午的块排到"已过去"）
    const effectiveStart = Math.max(winStart, nowCeil);
    if (effectiveStart >= winEnd) continue;

    const window: Interval = { start: effectiveStart, end: winEnd };
    const segments = freeSegments(window, busy, userIds);

    let dayMinutes = 0;
    let dayUnits = 0;

    for (const seg of segments) {
      if (qi >= units.length) break;
      if (dayMinutes >= dailyCap) break;

      let cursor = ceilToStep(seg.start);
      const segEnd = Math.floor(seg.end / MINUTE_MS) * MINUTE_MS;

      while (qi < units.length) {
        const unit = units[qi];
        const needMs = unit.minutes * MINUTE_MS;
        const remainingMs = segEnd - cursor;
        if (remainingMs < needMs) break;
        if (dayMinutes + unit.minutes > dailyCap) break;

        const end = cursor + needMs;
        slots.push({
          ...unit,
          start_ms: cursor,
          end_ms: end,
          date: dateKey,
        });
        cursor = end;
        dayMinutes += unit.minutes;
        dayUnits += 1;
        qi += 1;
      }
    }

    const busyMinutes = Math.max(0, Math.round((winEnd - effectiveStart) / MINUTE_MS) - segments.reduce(
      (s, seg) => s + Math.round((seg.end - seg.start) / MINUTE_MS),
      0,
    ));

    if (dayUnits > 0) {
      days.push({ date: dateKey, minutes: dayMinutes, units: dayUnits, busy_minutes: busyMinutes });
    } else if (segments.length > 0) {
      const longest = Math.max(
        ...segments.map((s) => Math.floor((s.end - s.start) / MINUTE_MS)),
      );
      if (longest < minSegmentMinutes) {
        warnings.push(`${dateKey} 的可用窗口被已有日程切得太碎（最长空档 ${longest} 分钟），未安排`);
      }
    }

    if (qi >= units.length) break;
  }

  const unplaced = units.slice(qi);
  const placedMinutes = slots.reduce((s, u) => s + u.minutes, 0);
  const placedUnits = slots.length;
  const endDate = slots.length > 0 ? slots[slots.length - 1].date : null;
  const daysNeeded = days.length;

  // deadline 容量核算：把 horizon 压到截止日再跑一次（不递归做 deadline，避免死循环）
  let deadlineFit: DeadlineFit | null = null;
  if (deadline) {
    const spanDays = Math.max(0, diffDays(startDate, deadline));
    const capped = packStudyPlan({
      ...params,
      deadline: null,
      horizonDays: spanDays + 1,
    });
    const capacity = capped.placed_minutes;
    const deficit = Math.max(0, totalMinutes - capacity);
    const availableDays = countStudyDays(startDate, deadline, validWeekdays);
    deadlineFit = {
      deadline,
      feasible: deficit === 0,
      capacity_minutes: capacity,
      deficit_minutes: deficit,
      extra_per_day:
        deficit > 0 && availableDays > 0
          ? Math.ceil(deficit / availableDays)
          : 0,
      available_days: availableDays,
    };
  }

  if (unplaced.length > 0) {
    warnings.push(
      `还有 ${unplaced.length} 个学习单元（约 ${unplaced.reduce(
        (s, u) => s + u.minutes,
        0,
      )} 分钟）在当前设置下排不进去`,
    );
  }
  if (deadlineFit && !deadlineFit.feasible) {
    warnings.push(
      `按当前节奏到 ${deadlineFit.deadline} 只能学 ${deadlineFit.capacity_minutes} 分钟，` +
        `差 ${deadlineFit.deficit_minutes} 分钟（同时有 ${deadlineFit.available_days} 个可用日，` +
        `每天需多学 ${deadlineFit.extra_per_day} 分钟）`,
    );
  }
  if (deadlineFit && deadlineFit.feasible && endDate && endDate < deadlineFit.deadline) {
    warnings.push(
      `按当前节奏 ${endDate} 就能学完，比截止日 ${deadlineFit.deadline} 提前 ${diffDays(
        endDate,
        deadlineFit.deadline,
      )} 天`,
    );
  }

  return {
    slots,
    unplaced,
    days,
    total_minutes: totalMinutes,
    placed_minutes: placedMinutes,
    placed_units: placedUnits,
    total_units: totalUnits,
    days_needed: daysNeeded,
    start_date: slots[0]?.date ?? startDate,
    end_date: endDate,
    daily_avg_minutes:
      daysNeeded > 0 ? Math.round(placedMinutes / daysNeeded) : 0,
    deadline_fit: deadlineFit,
    warnings,
  };
}

function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

/** a 到 b 相差的天数（b - a） */
export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000,
  );
}

/** 从 start 到 end（含两端）之间有几个可学日 */
export function countStudyDays(
  start: string,
  end: string,
  weekdays: number[],
): number {
  const span = diffDays(start, end);
  if (span < 0) return 0;
  let n = 0;
  for (let i = 0; i <= span; i++) {
    if (weekdays.includes(weekdayOf(addDays(start, i)))) n += 1;
  }
  return n;
}
