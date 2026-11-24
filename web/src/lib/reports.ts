import {
  addLocalDateKey,
  getOverviewBounds,
  localDateKey,
  type SpaceNavItem,
  type TodoRow,
} from "./todos";

export type ReportType = "day" | "week" | "month";

export const REPORT_TYPE_ORDER: ReportType[] = ["day", "week", "month"];

export const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  day: "日报",
  week: "周报",
  month: "月报",
};

export type ReportStatus = "done" | "in_progress" | "todo";

export const REPORT_STATUS_ORDER: ReportStatus[] = [
  "done",
  "in_progress",
  "todo",
];

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  done: "已完成",
  in_progress: "进行中",
  todo: "未开始",
};

/** 按任务名称关键字分类：BUG / FEAT / OPTIMIZE / REFACTOR / DOCS / TEST / OTHER */
const TASK_CATEGORY_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /bug|缺陷|修复|hotfix/i, label: "BUG" },
  { pattern: /feat|feature|新功能|新增|需求/i, label: "FEAT" },
  { pattern: /优化|性能|performance|optimize/i, label: "OPTIMIZE" },
  { pattern: /重构|refactor/i, label: "REFACTOR" },
  { pattern: /文档|doc/i, label: "DOCS" },
  { pattern: /测试|test/i, label: "TEST" },
];

export function taskCategory(title: string): string {
  for (const rule of TASK_CATEGORY_RULES) {
    if (rule.pattern.test(title)) return rule.label;
  }
  return "OTHER";
}

/** 分类显示名：BUG→修改、FEAT→新增，其余保持原样 */
export function categoryLabel(category: string): string {
  if (category === "BUG") return "修改";
  if (category === "FEAT") return "新增";
  return category;
}

/* ---------------------------------------------------------------
 * 任务描述生成（规则版兜底）
 *
 * 目标：语言严谨、信息完整、术语克制。
 * 描述由三部分组成：
 *   1) 状态 + 做到什么程度（progress）
 *   2) 结果或作用（value）
 *   3) 客观依据（detail：所属空间 / 时间 / 负责人，只有真实存在时才写）
 * 不出现 BUG / FEAT 之类的内部代号，不使用「搞定、差不多」这类口语。
 * ------------------------------------------------------------- */

export type DescriptionContext = {
  /** 所属空间名称 */
  spaceName?: string;
  /** 展示用时间，如 8/12 09:00~10:00、全天 8/12、完成于 8/12、待排期 */
  timeLabel?: string;
  /** Excel 口径的完成时间，如 2026-08-12 15:30 */
  completedLabel?: string | null;
  /** 负责人展示名 */
  assignees?: string[];
};

/** 状态对应的书面说法 */
const STATUS_WORD: Record<ReportStatus, string> = {
  done: "已完成",
  in_progress: "正在推进",
  todo: "尚未开始",
};

type DescPhrase = { progress: string; value: string };

/**
 * 分类 × 状态的描述短语。
 * progress = 做到什么程度（只陈述可确认的事实，不夸大成“彻底解决”，也不重复状态词）
 * value    = 结果或作用（对业务、团队、客户的实际影响）
 */
const DESCRIPTION_PHRASES: Record<string, Record<ReportStatus, DescPhrase>> = {
  BUG: {
    done: {
      progress: "问题原因已查明并修正，相关功能经复核恢复正常",
      value: "该问题不再影响正常使用，同类问题的发生概率同步降低",
    },
    in_progress: {
      progress: "修正工作已进入处理阶段，问题原因已查明，尚未完成复核",
      value: "处理完成后可恢复该功能的正常使用",
    },
    todo: {
      progress: "问题已记录在案，等待安排处理",
      value: "处理后可消除该问题对使用的影响",
    },
  },
  FEAT: {
    done: {
      progress: "开发工作已收尾并通过复核，可按预期使用",
      value: "为业务提供了新的支撑能力，原有的人工处理环节相应减少",
    },
    in_progress: {
      progress: "主体功能已具备，细节完善与复核仍在进行",
      value: "完成后可满足当前的业务使用需要",
    },
    todo: {
      progress: "需求已确认，等待进入开发",
      value: "完成后可补齐当前缺失的业务能力",
    },
  },
  OPTIMIZE: {
    done: {
      progress: "处理速度与资源占用均有改善，复核结果符合预期",
      value: "等待时间缩短，日常操作效率相应提升",
    },
    in_progress: {
      progress: "主要耗时环节已定位，改进效果仍在观察",
      value: "完成后可缩短处理时间、降低资源占用",
    },
    todo: {
      progress: "改进方案已拟定，等待实施",
      value: "实施后可缓解当前的性能压力",
    },
  },
  REFACTOR: {
    done: {
      progress: "结构调整已收尾，模块划分更清晰，原有功能保持正常",
      value: "后续修改与排查的成本降低，便于长期维护",
    },
    in_progress: {
      progress: "结构调整已开始，尚未全部完成，原有功能保持正常",
      value: "完成后可降低后续维护与排查成本",
    },
    todo: {
      progress: "调整方案已确定，等待实施",
      value: "实施后结构更清晰，便于后续维护",
    },
  },
  DOCS: {
    done: {
      progress: "文档已编写完成并归档，覆盖操作步骤与常见问题",
      value: "团队成员可直接查阅，减少重复沟通",
    },
    in_progress: {
      progress: "主体内容已具备，细节仍在校对",
      value: "完成后可供团队查阅与交接使用",
    },
    todo: {
      progress: "相关资料已收集，等待开始编写",
      value: "完成后便于交接与查阅",
    },
  },
  TEST: {
    done: {
      progress: "测试已执行完毕，覆盖主要业务场景，结果符合预期",
      value: "上线风险可控，交付质量有据可依",
    },
    in_progress: {
      progress: "主要场景已覆盖，剩余场景仍在补充",
      value: "完成后可确认本次改动的交付质量",
    },
    todo: {
      progress: "测试用例已列出，等待执行",
      value: "执行后可提前发现并处理潜在问题",
    },
  },
  OTHER: {
    done: {
      progress: "该项工作已按计划收尾，结果与预期一致",
      value: "为后续工作提供了可继续推进的基础",
    },
    in_progress: {
      progress: "该项工作已开始，尚未全部完成",
      value: "按当前进度可继续推进至收尾",
    },
    todo: {
      progress: "该项工作已列入本周期计划，等待排期",
      value: "将按计划推进并跟进结果",
    },
  },
};

function phraseFor(category: string, status: ReportStatus): DescPhrase {
  const table = DESCRIPTION_PHRASES[category] ?? DESCRIPTION_PHRASES.OTHER;
  return table[status];
}

/** 客观依据：所属空间、时间、负责人；缺哪项就不写，不臆测 */
function buildDetailClause(
  status: ReportStatus,
  ctx: DescriptionContext,
): string {
  const parts: string[] = [];
  const spaceName = ctx.spaceName?.trim();
  if (spaceName) parts.push(`所属空间为${spaceName}`);

  const timeLabel = ctx.timeLabel?.trim() ?? "";
  if (status === "done") {
    const completed = ctx.completedLabel?.trim();
    if (completed) parts.push(`完成时间为 ${completed}`);
    else if (timeLabel.startsWith("完成于")) {
      parts.push(`完成时间为 ${timeLabel.slice(4).trim()}`);
    }
  } else if (timeLabel && timeLabel !== "待排期") {
    parts.push(`安排时间为 ${timeLabel}`);
  } else {
    parts.push("尚未安排具体时间");
  }

  const assignees = (ctx.assignees ?? []).filter(Boolean);
  if (assignees.length > 0) parts.push(`由${assignees.join("、")}负责`);

  return parts.length > 0 ? `${parts.join("，")}。` : "";
}

/**
 * 一句话版本（Excel「任务」列等独立单元格使用）：
 * 「任务名」状态，做到什么程度；结果与作用。
 */
export function generateResultDescription(
  title: string,
  status: ReportStatus,
  category: string,
): string {
  const { progress, value } = phraseFor(category, status);
  return `「${title}」${STATUS_WORD[status]}，${progress}；${value}。`;
}

/** 兼容旧调用的别名，与 generateResultDescription 同义 */
export function generatePlainDescription(
  title: string,
  status: ReportStatus,
  category: string,
): string {
  return generateResultDescription(title, status, category);
}

/**
 * 详细版本（报告正文与 Excel「描述」列使用，标题在同行单独展示，不再重复）：
 * 状态 + 做到什么程度 + 结果与作用，末尾补充空间、时间、负责人等客观依据。
 */
export function generateTaskDescription(
  _title: string,
  status: ReportStatus,
  category: string,
  ctx: DescriptionContext = {},
): string {
  const { progress, value } = phraseFor(category, status);
  const detail = buildDetailClause(status, ctx);
  return `${STATUS_WORD[status]}，${progress}；${value}。${detail}`;
}

/** 开拓隆海 logo 主色（青色系），供 Excel 导出使用 */
const LOGO_CYAN = "#007080";
const LOGO_CYAN_DARK = "#005663";
const LOGO_CYAN_TITLE_BG = "#DFEEF0";
const LOGO_CYAN_ZEBRA = "#EFF6F7";
const LOGO_CYAN_BORDER = "#C9DDE0";

export type ReportTask = {
  id: string;
  title: string;
  description: string | null;
  /** 展示用描述：有原始描述用原始描述，否则按任务名称自动生成 */
  description_display: string;
  priority: "high" | "medium" | "low";
  status: ReportStatus;
  space_id: string;
  space_name: string;
  /** 分类：按任务名称关键字，如 BUG / FEAT / OPTIMIZE / OTHER */
  category: string;
  /** 展示用时间，如 8/12 10:00~11:00、全天 8/12、完成于 8/12 */
  time_label: string;
  /** 报告条目里的日期，如 08/12 09:00~10:00、08/12 全天、08/11 完成 */
  report_date_label: string;
  /** 任务主日期 YYYY-MM-DD（排期开始日或完成日），用于默认勾选当前周期任务 */
  date_iso: string | null;
  /** Excel 明细：开始时间（展示文本），未排期时为 null */
  start_label: string | null;
  /** Excel 明细：结束时间（展示文本），未排期时为 null */
  end_label: string | null;
  /** Excel 明细：完成时间（展示文本），未完成时为 null */
  completed_label: string | null;
  /** 完成进展：已完成 / 进行中 / 未开始 */
  progress_label: string;
  /** 遇到的问题（暂无数据源时显示暂无） */
  issue_label: string;
  /** 指派成员展示名 */
  assignees: string[];
};

export type ReportSpaceGroup = {
  space_id: string;
  space_name: string;
  total: number;
  counts: Record<ReportStatus, number>;
  tasks: ReportTask[];
};

export type ReportTotals = Record<ReportStatus, number> & { total: number };

export type ReportDataLike = {
  type: ReportType;
  /** 周期标题，如 2026/08/10 ~ 2026/08/16 */
  rangeLabel: string;
  /** 输入控件回显值：日/周 YYYY-MM-DD，月 YYYY-MM */
  input: string;
  spaces: ReportSpaceGroup[];
  totals: ReportTotals;
  /** 当前已选空间展示名 */
  selectedSpacesLabel: string;
};

export type ReportData = ReportDataLike & { start: Date; end: Date };

/** 传给客户端组件时去掉 Date 字段，保持纯可序列化数据 */
export function stripReportData(data: ReportData): ReportDataLike {
  return {
    type: data.type,
    rangeLabel: data.rangeLabel,
    input: data.input,
    spaces: data.spaces,
    totals: data.totals,
    selectedSpacesLabel: data.selectedSpacesLabel,
  };
}

export function parseReportType(raw: string | null | undefined): ReportType {
  if (raw === "day" || raw === "month") return raw;
  return "week";
}

/** 从 URL 解析输入日期；非法/缺失时返回空字符串，由调用方使用今天 */
export function parseReportInput(
  type: ReportType,
  raw: string | null | undefined,
): string {
  const value = raw?.trim() ?? "";
  if (type === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(value);
    return m ? `${m[1]}-${m[2]}` : "";
  }
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!d) return "";
  const date = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  if (
    Number.isNaN(date.getTime()) ||
    localDateKey(date) !== `${d[1]}-${d[2]}-${d[3]}`
  ) {
    return "";
  }
  return `${d[1]}-${d[2]}-${d[3]}`;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatSlashDate(d: Date) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatMonthLabel(y: number, m: number) {
  return `${y} 年 ${m} 月`;
}

export function resolveReportRange(
  type: ReportType,
  rawDate: string | null | undefined,
): { start: Date; end: Date; input: string; rangeLabel: string } {
  const now = new Date();
  if (type === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(rawDate?.trim() ?? "");
    // ⚠️ 正则只校验了「两位数字」，`2026-13` / `2026-00` 会被 Date 静默
    // 折算成次年的 1 月 / 上一年的 12 月，导致报告标题与内容对不上。
    // 解析后回读月份，不一致就当作没传。
    let parsedMonth: Date | null = null;
    if (m) {
      const monthNum = Number(m[2]);
      if (monthNum >= 1 && monthNum <= 12) {
        const candidate = new Date(Number(m[1]), monthNum - 1, 1);
        if (
          candidate.getMonth() === monthNum - 1 &&
          candidate.getFullYear() === Number(m[1])
        ) {
          parsedMonth = candidate;
        }
      }
    }
    const base = parsedMonth ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const start = new Date(
      base.getFullYear(),
      base.getMonth(),
      1,
      0,
      0,
      0,
      0,
    );
    const end = new Date(
      base.getFullYear(),
      base.getMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    );
    return {
      start,
      end,
      input: `${base.getFullYear()}-${pad2(base.getMonth() + 1)}`,
      rangeLabel: formatMonthLabel(base.getFullYear(), base.getMonth() + 1),
    };
  }

  const parsed = parseReportInput(type, rawDate);
  const base = parsed
    ? new Date(
        Number(parsed.slice(0, 4)),
        Number(parsed.slice(5, 7)) - 1,
        Number(parsed.slice(8, 10)),
      )
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const { start, end } = getOverviewBounds(type, base);
  const input = localDateKey(base);
  const rangeLabel =
    type === "day"
      ? formatSlashDate(start)
      : `${formatSlashDate(start)} ~ ${formatSlashDate(end)}`;
  return { start, end, input, rangeLabel };
}

/**
 * 按报告周期过滤任务。
 *
 * 此前「日报 / 周报 / 月报」三份报告内容完全一样 —— 查询只有空间与状态条件，
 * 没有时间条件，选「日报 11/02」会列出该空间全部历史未完成待办。
 *
 * 规则（未完成任务用「区间相交」，保证跨周期长任务不丢）：
 *   - 已完成：completed_at 落在本周期内
 *   - 未排期（start_at 为空）：始终算入，属于 backlog
 *   - 其余：start_at <= 周期结束 且（无结束时间 或 end_at >= 周期开始）
 */
export function filterTodosForRange<T extends TodoRow>(
  todos: T[],
  start: Date,
  end: Date,
): T[] {
  const startMs = start.getTime();
  const endMs = end.getTime();
  return todos.filter((todo) => {
    const status = (todo as { status?: string }).status;
    if (status === "done") {
      const doneAt = todo.completed_at
        ? new Date(todo.completed_at as string).getTime()
        : Number.NaN;
      return (
        Number.isFinite(doneAt) && doneAt >= startMs && doneAt <= endMs
      );
    }
    if (!todo.start_at) return true;
    const startAt = new Date(todo.start_at as string).getTime();
    if (!Number.isFinite(startAt)) return true;
    if (startAt > endMs) return false; // 还没到开始时间的未来任务
    if (!todo.end_at) return true;
    const endAt = new Date(todo.end_at as string).getTime();
    if (!Number.isFinite(endAt)) return true;
    return endAt >= startMs;
  });
}

/**
 * 把周期内的任务拆成「已排期」与「未排期 backlog」两堆。
 *
 * 未排期 = 未完成且 start_at 为空。此前它们混在报告主列表里、还占着完成率分母，
 * 导致「本日已完成 3/8」这种数字里混进一堆根本不属于本周期的事。
 * 现在 backlog 单独成块展示，不参与任何统计。
 */
export function splitBacklogTodos<T extends TodoRow>(todos: T[]): {
  ranged: T[];
  backlog: T[];
} {
  const ranged: T[] = [];
  const backlog: T[] = [];
  for (const todo of todos) {
    const status = (todo as { status?: string }).status;
    if (status !== "done" && !todo.start_at) backlog.push(todo);
    else ranged.push(todo);
  }
  return { ranged, backlog };
}

/** URL 中逗号分隔的空间 id；只保留当前用户可见的空间 */
export function parseReportSpaceIds(
  raw: string | null | undefined,
  spaces: SpaceNavItem[],
): string[] {
  const valid = new Set(spaces.map((s) => s.id));
  const picked = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => valid.has(s));
  return picked.length > 0 ? picked : spaces.map((s) => s.id);
}

function formatTimeLabel(todo: TodoRow): string {
  if (todo.status === "done" && todo.completed_at) {
    const d = new Date(todo.completed_at);
    return `完成于 ${d.getMonth() + 1}/${d.getDate()}`;
  }
  if (todo.is_all_day && todo.start_at) {
    const s = new Date(todo.start_at);
    const label = `${s.getMonth() + 1}/${s.getDate()}`;
    if (todo.end_at) {
      const e = new Date(todo.end_at);
      const endMidnight =
        e.getHours() === 0 && e.getMinutes() === 0 && e.getSeconds() === 0;
      if (!endMidnight || e.getTime() <= s.getTime()) return `全天 ${label}`;
      const endYmd = localDateKey(e);
      if (endYmd === addLocalDateKey(localDateKey(s), 1)) {
        return `全天 ${label}`;
      }
      return `全天 ${label} ~ ${e.getMonth() + 1}/${e.getDate()}`;
    }
    return `全天 ${label}`;
  }
  if (todo.start_at) {
    const s = new Date(todo.start_at);
    const hm = (d: Date) =>
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const dateLabel = `${s.getMonth() + 1}/${s.getDate()}`;
    if (!todo.end_at) return `${dateLabel} ${hm(s)}`;
    const e = new Date(todo.end_at);
    const sameDay =
      s.getFullYear() === e.getFullYear() &&
      s.getMonth() === e.getMonth() &&
      s.getDate() === e.getDate();
    return sameDay
      ? `${dateLabel} ${hm(s)}~${hm(e)}`
      : `${dateLabel} ${hm(s)} ~ ${e.getMonth() + 1}/${e.getDate()} ${hm(e)}`;
  }
  return "待排期";
}

function formatFullDate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatFullDateTime(d: Date) {
  return `${formatFullDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatMd(d: Date) {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** Excel 用：日期只显示到天，如 08/11；无日期显示待排期 */
export function formatDayLabel(dateIso: string | null): string {
  if (!dateIso) return "待排期";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!m) return dateIso;
  return `${m[2]}/${m[3]}`;
}

/** 下一周期边界：日报=明天，周报=下周（周一~周日），月报=下月 */
export function nextPeriodBounds(
  type: ReportType,
  input: string,
): { startKey: string; endKey: string } | null {
  if (type === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(input);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const start = new Date(y, mo, 1);
    const end = new Date(y, mo + 1, 0, 23, 59, 59, 999);
    return { startKey: localDateKey(start), endKey: localDateKey(end) };
  }
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!d) return null;
  if (type === "day") {
    const next = addLocalDateKey(`${d[1]}-${d[2]}-${d[3]}`, 1);
    return { startKey: next, endKey: next };
  }
  const base = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  const { start, end } = getOverviewBounds("week", base);
  return {
    startKey: addLocalDateKey(localDateKey(start), 7),
    endKey: addLocalDateKey(localDateKey(end), 7),
  };
}

/** 下一周期的计划任务：未开始且排期落在下一周期 */
export function nextPlanTasks(data: ReportDataLike): ReportTask[] {
  const bounds = nextPeriodBounds(data.type, data.input);
  if (!bounds) return [];
  return data.spaces
    .flatMap((g) => g.tasks)
    .filter(
      (t) =>
        t.status === "todo" &&
        !!t.date_iso &&
        t.date_iso >= bounds.startKey &&
        t.date_iso <= bounds.endKey,
    )
    .sort((a, b) =>
      (a.date_iso ?? "9999").localeCompare(b.date_iso ?? "9999"),
    );
}

/** 任务明细字段：Excel 使用的完整时间文本 + 展示用简短标签 */
function formatTaskLabels(todo: TodoRow): {
  time_label: string;
  report_date_label: string;
  date_iso: string | null;
  start_label: string | null;
  end_label: string | null;
  completed_label: string | null;
} {
  let start_label: string | null = null;
  let end_label: string | null = null;
  let completed_label: string | null = null;
  let report_date_label = "待排期";
  let date_iso: string | null = null;
  if (todo.completed_at) {
    const c = new Date(todo.completed_at);
    completed_label = formatFullDateTime(c);
    date_iso = localDateKey(c);
    report_date_label = formatMd(c);
  }
  if (todo.start_at) {
    const s = new Date(todo.start_at);
    if (todo.is_all_day) {
      start_label = formatFullDate(s);
      if (todo.end_at) {
        const e = new Date(todo.end_at);
        end_label = formatFullDate(e);
        const endMidnight =
          e.getHours() === 0 && e.getMinutes() === 0 && e.getSeconds() === 0;
        const lastDay = endMidnight
          ? new Date(e.getTime() - 60 * 1000)
          : e;
        if (!todo.completed_at) {
          date_iso = localDateKey(s);
          report_date_label =
            localDateKey(lastDay) !== localDateKey(s)
              ? `${formatMd(s)}~${formatMd(lastDay)}`
              : formatMd(s);
        }
      } else if (!todo.completed_at) {
        date_iso = localDateKey(s);
        report_date_label = formatMd(s);
      }
    } else {
      start_label = formatFullDateTime(s);
      end_label = todo.end_at
        ? formatFullDateTime(new Date(todo.end_at))
        : null;
      if (!todo.completed_at) {
        date_iso = localDateKey(s);
        report_date_label = formatMd(s);
      }
      if (todo.end_at && !todo.completed_at) {
        const e = new Date(todo.end_at);
        const sameDay =
          s.getFullYear() === e.getFullYear() &&
          s.getMonth() === e.getMonth() &&
          s.getDate() === e.getDate();
        report_date_label = sameDay
          ? formatMd(s)
          : `${formatMd(s)}~${formatMd(e)}`;
      }
    }
  }
  return {
    time_label: formatTimeLabel(todo),
    report_date_label,
    date_iso,
    start_label,
    end_label,
    completed_label,
  };
}

export function buildReportData(args: {
  type: ReportType;
  range: { start: Date; end: Date; input: string; rangeLabel: string };
  selectedSpaces: SpaceNavItem[];
  todos: TodoRow[];
  canAssignBySpace: Record<string, boolean>;
  userId: string;
  /** 为 true 时只保留指派给我的任务（个人周报）；false 时保留 owner/admin 的整空间团队视图 */
  mineOnly: boolean;
}): ReportData {
  const {
    type,
    range,
    selectedSpaces,
    todos,
    canAssignBySpace,
    userId,
    mineOnly,
  } = args;
  const spaceById = new Map(selectedSpaces.map((s) => [s.id, s]));
  const groups = new Map<string, ReportSpaceGroup>();

  for (const todo of todos) {
    const assignedToMe = (todo.todo_assignees ?? []).some(
      (a) => a.user_id === userId,
    );
    // 「只看我的任务」开启：无论是否 owner/admin，仅保留指派给我的（无指派人也不显示）。
    // 关闭：保留原行为——owner/admin 看整个空间（团队周报），普通成员只看指派给我的。
    if (mineOnly) {
      if (!assignedToMe) continue;
    } else {
      const canAssign = canAssignBySpace[todo.space_id] === true;
      if (!canAssign && !assignedToMe) continue;
    }

    const space = spaceById.get(todo.space_id);
    const spaceName = space?.name ?? "空间";
    let group = groups.get(todo.space_id);
    if (!group) {
      group = {
        space_id: todo.space_id,
        space_name: spaceName,
        total: 0,
        counts: { done: 0, in_progress: 0, todo: 0 },
        tasks: [],
      };
      groups.set(todo.space_id, group);
    }
    const status = todo.status === "done" ? "done" : todo.status === "in_progress" ? "in_progress" : "todo";
    const labels = formatTaskLabels(todo);
    const category = taskCategory(todo.title);
    const assignees = (todo.todo_assignees ?? [])
      .map((a) => a.profiles?.display_name?.trim() || "")
      .filter(Boolean);
    group.total += 1;
    group.counts[status] += 1;
    group.tasks.push({
      id: todo.id,
      title: todo.title,
      description: todo.description,
      description_display:
        todo.description?.trim() ||
        generateTaskDescription(todo.title, status, category, {
          spaceName,
          timeLabel: labels.time_label,
          assignees,
        }),
      priority: todo.priority,
      status,
      space_id: todo.space_id,
      space_name: spaceName,
      category,
      time_label: labels.time_label,
      report_date_label: labels.report_date_label,
      date_iso: labels.date_iso,
      start_label: labels.start_label,
      end_label: labels.end_label,
      completed_label: labels.completed_label,
      progress_label:
        status === "done"
          ? "已完成"
          : status === "in_progress"
            ? "进行中"
            : "未开始",
      issue_label: "暂无",
      assignees,
    });
  }

  for (const group of groups.values()) {
    group.tasks.sort((a, b) => {
      const ai = REPORT_STATUS_ORDER.indexOf(a.status);
      const bi = REPORT_STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.time_label.localeCompare(b.time_label, "zh-CN");
    });
  }

  const spaceGroups = [...groups.values()].sort((a, b) =>
    a.space_name.localeCompare(b.space_name, "zh-CN"),
  );
  const totals: ReportTotals = {
    done: 0,
    in_progress: 0,
    todo: 0,
    total: 0,
  };
  for (const g of spaceGroups) {
    totals.total += g.total;
    totals.done += g.counts.done;
    totals.in_progress += g.counts.in_progress;
    totals.todo += g.counts.todo;
  }

  const selectedSpacesLabel =
    selectedSpaces.length === 0
      ? "全部空间"
      : selectedSpaces.length === 1
        ? selectedSpaces[0].name
        : `已选 ${selectedSpaces.length} 个空间`;

  return {
    type,
    rangeLabel: range.rangeLabel,
    input: range.input,
    start: range.start,
    end: range.end,
    spaces: spaceGroups,
    totals,
    selectedSpacesLabel,
  };
}

/** 各周期“进展”章节标题 */
const REPORT_PROGRESS_LABEL: Record<ReportType, string> = {
  day: "今日工作进展",
  week: "本周工作进展",
  month: "本月工作进展",
};

/** 各周期“计划”章节标题 */
export const REPORT_NEXT_LABEL: Record<ReportType, string> = {
  day: "明天计划",
  week: "下周计划",
  month: "下月计划",
};

/** 按《周报规则》（supabase/services/api/zhoubaoguize）四段式生成报告文本 */
export function buildReportText(data: ReportDataLike): string {
  const typeLabel = REPORT_TYPE_LABEL[data.type];
  const allTasks = data.spaces.flatMap((g) => g.tasks);
  const done = allTasks.filter((t) => t.status === "done");
  const doing = allTasks.filter((t) => t.status === "in_progress");
  const plan = nextPlanTasks(data);

  if (allTasks.length === 0) {
    return `**${typeLabel} (${data.rangeLabel})**\n范围：${data.selectedSpacesLabel} · 0 项任务\n\n所选空间暂无任务。`;
  }

  const lines: string[] = [
    `**${typeLabel} (${data.rangeLabel})**`,
    `范围：${data.selectedSpacesLabel} · ${data.totals.total} 项任务（完成 ${data.totals.done} · 进行中 ${data.totals.in_progress} · 未开始 ${data.totals.todo}）`,
    "",
    `**一、${REPORT_PROGRESS_LABEL[data.type]}**（已完成 ${done.length} 项）`,
    ...done.map(
      (t) =>
        `* [${t.report_date_label}] ${t.title}：${t.description_display}`,
    ),
    "",
    `**二、进行中的工作**（${doing.length} 项）`,
    ...doing.map(
      (t) =>
        `* [${t.report_date_label}] ${t.title}：${t.description_display}`,
    ),
    "",
    "**三、遇到的问题与风险**",
    "* 暂无",
    "",
    `**四、${REPORT_NEXT_LABEL[data.type]}**（${plan.length} 项）`,
    ...plan.map(
      (t) =>
        `* [${t.report_date_label}] ${t.title}：${t.description_display}`,
    ),
  ];
  return lines.join("\n");
}

/** 按选中的任务 id 过滤报告数据，重新计算各空间与总计数 */
export function filterReportData(
  data: ReportDataLike,
  selectedIds: ReadonlySet<string>,
): ReportDataLike {
  const spaces = data.spaces
    .map((group) => {
      const tasks = group.tasks.filter((t) => selectedIds.has(t.id));
      const counts: Record<ReportStatus, number> = {
        done: 0,
        in_progress: 0,
        todo: 0,
      };
      for (const t of tasks) counts[t.status] += 1;
      return { ...group, tasks, total: tasks.length, counts };
    })
    .filter((g) => g.total > 0);
  const totals: ReportTotals = {
    total: 0,
    done: 0,
    in_progress: 0,
    todo: 0,
  };
  for (const g of spaces) {
    totals.total += g.total;
    totals.done += g.counts.done;
    totals.in_progress += g.counts.in_progress;
    totals.todo += g.counts.todo;
  }
  return { ...data, spaces, totals };
}

/** 导出文件名，如 周报_2026-08-10-2026-08-16.xlsx */
export function reportFileName(data: ReportDataLike): string {
  const base = REPORT_TYPE_LABEL[data.type];
  const range = data.rangeLabel
    .replace(/[/~]+/g, "-")
    .replace(/\s+/g, "");
  return `${base}_${range}.xlsx`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 生成 Excel 2003 XML（SpreadsheetML）。无第三方依赖，
 * Excel / WPS 可直接打开，含「报告汇总」与「任务明细」两个工作表。
 */
export function buildReportXlsxXml(
  data: ReportDataLike,
  opts?: { taskPlainText?: Record<string, string> },
): string {
  const typeLabel = REPORT_TYPE_LABEL[data.type];
  const title = `【${typeLabel}】${data.rangeLabel}`;
  const subtitle = `范围：${data.selectedSpacesLabel} · ${data.totals.total} 项任务（完成 ${data.totals.done} · 进行中 ${data.totals.in_progress} · 未开始 ${data.totals.todo}）`;
  const taskPlainText = opts?.taskPlainText ?? {};

  // 汇总表：部门 + 分类 + 日期（只到天）+ 任务
  const summaryHeader = ["部门", "分类", "日期", "任务"];
  const detailHeader = [
    "部门",
    "分类",
    "日期",
    "任务",
    "时间",
    "完成进展",
    "遇到的问题",
    "状态",
    "描述",
  ];
  const planHeader = ["部门", "分类", "日期", "任务", "描述"];

  const textCell = (text: string, style = "Cell") =>
    `<Cell ss:StyleID="${style}"><Data ss:Type="String">${xmlEscape(text)}</Data></Cell>`;
  const linkCell = (text: string, href: string, style = "Link") =>
    `<Cell ss:StyleID="${style}" ss:HRef="${href}"><Data ss:Type="String">${xmlEscape(text)}</Data></Cell>`;
  const headCell = (text: string) =>
    `<Cell ss:StyleID="Header"><Data ss:Type="String">${xmlEscape(text)}</Data></Cell>`;
  const mergedCell = (text: string, style: string, span: number) =>
    `<Cell ss:StyleID="${style}" ss:MergeAcross="${span}"><Data ss:Type="String">${xmlEscape(text)}</Data></Cell>`;
  const dataRow = (cells: string[]) => `<Row ss:Height="20">${cells.join("")}</Row>`;
  const headerRow = (headers: string[]) =>
    `<Row ss:Height="24">${headers.map(headCell).join("")}</Row>`;
  // 任务栏统一口径：优先 AI 改写，缺失时按任务名称规则生成严谨描述
  const plainLabel = (task: ReportTask) =>
    taskPlainText[task.id] ||
    generateResultDescription(task.title, task.status, task.category);

  // 两个工作表前 4 行固定为标题/范围/空行/表头，数据从第 5 行开始
  const header4 = (titleText: string, subtitleText: string, headers: string[], span: number) => [
    `<Row ss:Height="30">${mergedCell(titleText, "Title", span)}</Row>`,
    `<Row ss:Height="18">${mergedCell(subtitleText, "Subtitle", span)}</Row>`,
    `<Row ss:Height="8">${mergedCell("", "Subtitle", span)}</Row>`,
    headerRow(headers),
  ];

  const summaryRows = header4(
    title,
    subtitle,
    summaryHeader,
    summaryHeader.length - 1,
  );
  let detailRow = 5;
  data.spaces.flatMap((g) => g.tasks).forEach((task, idx) => {
    const z = idx % 2 === 1;
    summaryRows.push(
      dataRow([
        textCell(task.space_name, z ? "ZebraCenter" : "Center"),
        textCell(categoryLabel(task.category), z ? "ZebraCenter" : "Center"),
        textCell(formatDayLabel(task.date_iso), z ? "ZebraCenter" : "Center"),
        linkCell(
          task.title,
          `#任务明细!A${detailRow}`,
          z ? "ZebraLink" : "Link",
        ),
      ]),
    );
    detailRow += 1;
  });

  const detailRows = header4(
    title,
    subtitle,
    detailHeader,
    detailHeader.length - 1,
  );
  data.spaces.flatMap((g) => g.tasks).forEach((task, idx) => {
    const z = idx % 2 === 1;
    detailRows.push(
      dataRow([
        textCell(task.space_name, z ? "ZebraCenter" : "Center"),
        textCell(categoryLabel(task.category), z ? "ZebraCenter" : "Center"),
        textCell(formatDayLabel(task.date_iso), z ? "ZebraCenter" : "Center"),
        textCell(plainLabel(task), z ? "Zebra" : "Cell"),
        textCell(formatDayLabel(task.date_iso), z ? "Zebra" : "Cell"),
        textCell(task.progress_label, z ? "ZebraCenter" : "Center"),
        textCell(task.issue_label, z ? "Zebra" : "Cell"),
        textCell(
          REPORT_STATUS_LABEL[task.status],
          z ? "ZebraCenter" : "Center",
        ),
        textCell(task.description_display, z ? "Zebra" : "Cell"),
      ]),
    );
  });

  // 下周 / 下月 / 明天计划工作表（按《周报规则》第四节）
  const planSheetName = REPORT_NEXT_LABEL[data.type];
  const planTasks = nextPlanTasks(data);
  const planRows = header4(
    `【${typeLabel}】${data.rangeLabel} · ${planSheetName}`,
    `计划任务 ${planTasks.length} 项（未开始）`,
    planHeader,
    planHeader.length - 1,
  );
  planTasks.forEach((task, idx) => {
    const z = idx % 2 === 1;
    planRows.push(
      dataRow([
        textCell(task.space_name, z ? "ZebraCenter" : "Center"),
        textCell(categoryLabel(task.category), z ? "ZebraCenter" : "Center"),
        textCell(formatDayLabel(task.date_iso), z ? "ZebraCenter" : "Center"),
        textCell(plainLabel(task), z ? "Zebra" : "Cell"),
        textCell(task.description_display, z ? "Zebra" : "Cell"),
      ]),
    );
  });

  const thinBorder =
    `<Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${LOGO_CYAN_BORDER}"/></Borders>`;
  const wsOptions =
    `<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><PageSetup><Orientation>Landscape</Orientation><FitToPage/><FitWidth>1</FitWidth><FitHeight>0</FitHeight></PageSetup><FreezePanes><FreezeRows>4</FreezeRows><FreezeColumns>1</FreezeColumns></FreezePanes></WorksheetOptions>`;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<?mso-application progid="Excel.Sheet"?>`,
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">`,
    `<Styles>`,
    `<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="#1F2937"/></Style>`,
    `<Style ss:ID="Title"><Alignment ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="14" ss:Bold="1" ss:Color="${LOGO_CYAN}"/><Interior ss:Color="${LOGO_CYAN_TITLE_BG}" ss:Pattern="Solid"/></Style>`,
    `<Style ss:ID="Subtitle"><Alignment ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="#6B7280"/></Style>`,
    `<Style ss:ID="Header"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="${LOGO_CYAN}" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="${LOGO_CYAN_DARK}"/></Borders></Style>`,
    `<Style ss:ID="Cell"><Alignment ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="#1F2937"/>${thinBorder}</Style>`,
    `<Style ss:ID="Center"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="#1F2937"/>${thinBorder}</Style>`,
    `<Style ss:ID="Zebra"><Alignment ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="#1F2937"/><Interior ss:Color="${LOGO_CYAN_ZEBRA}" ss:Pattern="Solid"/>${thinBorder}</Style>`,
    `<Style ss:ID="ZebraCenter"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="#1F2937"/><Interior ss:Color="${LOGO_CYAN_ZEBRA}" ss:Pattern="Solid"/>${thinBorder}</Style>`,
    `<Style ss:ID="Link"><Alignment ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="${LOGO_CYAN}" ss:Underline="Single"/>${thinBorder}</Style>`,
    `<Style ss:ID="ZebraLink"><Alignment ss:Vertical="Center"/><Font ss:FontName="微软雅黑" ss:Size="10" ss:Color="${LOGO_CYAN}" ss:Underline="Single"/><Interior ss:Color="${LOGO_CYAN_ZEBRA}" ss:Pattern="Solid"/>${thinBorder}</Style>`,
    `</Styles>`,
    `<Worksheet ss:Name="报告汇总"><Table>`,
    `<Column ss:Width="120"/><Column ss:Width="90"/><Column ss:Width="80"/><Column ss:Width="320"/>`,
    summaryRows.join(""),
    `</Table>${wsOptions}</Worksheet>`,
    `<Worksheet ss:Name="任务明细"><Table>`,
    `<Column ss:Width="120"/><Column ss:Width="80"/><Column ss:Width="80"/><Column ss:Width="220"/><Column ss:Width="170"/><Column ss:Width="80"/><Column ss:Width="120"/><Column ss:Width="80"/><Column ss:Width="240"/>`,
    detailRows.join(""),
    `</Table>${wsOptions}</Worksheet>`,
    `<Worksheet ss:Name="${planSheetName}"><Table>`,
    `<Column ss:Width="120"/><Column ss:Width="90"/><Column ss:Width="80"/><Column ss:Width="260"/><Column ss:Width="320"/>`,
    planRows.join(""),
    `</Table>${wsOptions}</Worksheet>`,
    `</Workbook>`,
  ].join("\n");
}
