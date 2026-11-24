/**
 * 学习计划领域逻辑（纯函数，不碰数据库）
 *
 * 职责边界：
 *   - 章节树 → 学习单元（叶子筛选、超长章节拆分、分钟数规整）
 *   - 排期结果 → 待办文案
 * AI 只负责「哪些章节 + 这节大概多少页 + 难度」，这里负责把章切成「能在日历上执行」的块。
 *
 * 估时口径（关键，2026-11-23 起）：
 *   不再让 AI 直接吐分钟数（它无法自证，也没法被校正），而是让它吐两个可观测量：
 *     pages      这项在书上大约多少页
 *     difficulty 1=概念/记忆为主  2=普通  3=证明/计算密集（必须动笔）
 *   分钟数由确定性公式算出：
 *     minutes = pages × minPerPage × DIFFICULTY_FACTOR[difficulty]
 *   误差来源因此收敛成一个用户可理解、可调整的旋钮 minPerPage（我一页要几分钟）。
 *   AI 万一没给 pages，退回旧的 minutes 字段，保证向后兼容。
 */

import type { StudyUnit } from "../lib/study-packing";

export type OutlineChapter = {
  no?: number | null;
  title: string;
  level?: number | null;
  parent_no?: number | null;
  minutes?: number | null;
  pages?: number | null;
  difficulty?: number | null;
};

export type NormalizedChapter = {
  no: number;
  title: string;
  level: number;
  parent_no: number | null;
  minutes: number;
  /** 页数；AI 没给时为 null（此时 minutes 来自旧字段或兜底） */
  pages: number | null;
  /** 难度 1~3；无页数时为 null */
  difficulty: number | null;
};

/** 单个学习单元的时长上限：超过它的章节要拆开，否则日历上会出现一个 3 小时的块 */
export const SPLIT_ABOVE_FACTOR = 1.6;

/** 「每页多少分钟」默认值：中文教材一页含公式/证明，读+理解+随手做题约 7 分钟 */
export const DEFAULT_MIN_PER_PAGE = 7;

/** 每页分钟的合理区间（前端可调），超出即视为输入错误 */
export const MIN_PER_PAGE_MIN = 1;
export const MIN_PER_PAGE_MAX = 20;

/**
 * 难度系数：证明/计算密集的材料，一页花的时间明显高于纯概念页。
 * 刻意只保留三个档位 —— 档位越多用户越不知道该调哪个。
 */
const DIFFICULTY_FACTOR: Record<number, number> = {
  1: 0.85,
  2: 1,
  3: 1.35,
};

export function clampMinPerPage(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MIN_PER_PAGE;
  return Math.min(
    MIN_PER_PAGE_MAX,
    Math.max(MIN_PER_PAGE_MIN, Math.round(v * 10) / 10),
  );
}

export function normalizeDifficulty(d: unknown): number | null {
  const v = Number(d);
  if (!Number.isFinite(v)) return null;
  return Math.min(3, Math.max(1, Math.round(v)));
}

export function difficultyFactor(d: number | null | undefined): number {
  const k = normalizeDifficulty(d);
  return k === null ? 1 : DIFFICULTY_FACTOR[k] ?? 1;
}

/** 页数 + 难度 + 每页分钟 → 分钟数（系统里唯一的估时公式） */
export function estimateMinutes(
  pages: number,
  difficulty: number | null | undefined,
  minPerPage: number,
): number {
  return Math.max(
    5,
    pages * clampMinPerPage(minPerPage) * difficultyFactor(difficulty),
  );
}

/** 分钟数规整到 5 分钟网格，且不小于 10 分钟 */
function roundMinutes(n: number): number {
  return Math.max(10, Math.round(n / 5) * 5);
}

/**
 * 清洗 AI / 用户给的章节数组：
 * - 丢掉没标题的项
 * - no 缺失或重复时重新编号
 * - level 限制在 1~3，parent_no 必须指向已存在的 no
 * - minutes：有 pages 就按公式算，没有就退回 AI 给的 minutes，最后兜底 fallbackMinutes
 */
export function normalizeChapters(
  chapters: OutlineChapter[],
  fallbackMinutes: number,
  minPerPage: number = DEFAULT_MIN_PER_PAGE,
): NormalizedChapter[] {
  const raw = (Array.isArray(chapters) ? chapters : []).filter(
    (c) => c && typeof c.title === "string" && c.title.trim(),
  );

  const used = new Set<number>();
  // 原始 no → 重排后的新 no。父引用必须按此映射换算，否则缺号/重复被重排后
  // parent_no 会错位甚至指向不存在的章节（见下文的校验）。
  const noMap = new Map<number, number>();
  const out: NormalizedChapter[] = [];

  for (const c of raw) {
    const originalNo =
      typeof c.no === "number" && Number.isFinite(c.no) ? Math.trunc(c.no) : 0;
    let no = originalNo;
    if (no <= 0 || used.has(no)) {
      no = 1;
      while (used.has(no)) no += 1;
    }
    used.add(no);
    // 只记录首次出现：重复 no 的父引用本就含糊，取第一处最稳
    if (originalNo > 0 && !noMap.has(originalNo)) {
      noMap.set(originalNo, no);
    }

    // 页数是「可校准量」：有它就走公式，没有才退回旧口径
    const rawPages = Number(c.pages);
    const pages =
      Number.isFinite(rawPages) && rawPages > 0
        ? Math.min(2000, Math.round(rawPages))
        : null;
    const difficulty = pages === null ? null : normalizeDifficulty(c.difficulty);

    const minutes =
      pages !== null
        ? estimateMinutes(pages, difficulty, minPerPage)
        : Number(c.minutes) || fallbackMinutes;

    out.push({
      no,
      title: c.title.trim().slice(0, 255),
      level: Math.min(3, Math.max(1, Math.trunc(Number(c.level) || 1))),
      parent_no: null, // 先填，后面统一校验
      minutes: roundMinutes(minutes),
      pages,
      difficulty,
    });
  }

  raw.forEach((c, i) => {
    const parent = typeof c.parent_no === "number" ? Math.trunc(c.parent_no) : null;
    // 原始 parent_no → 重排后的 no，再校验存在性；否则缺号重排会错位
    const mappedParent =
      parent !== null && noMap.has(parent) ? noMap.get(parent)! : parent;
    out[i].parent_no =
      mappedParent !== null &&
      mappedParent !== out[i].no &&
      used.has(mappedParent)
        ? mappedParent
        : null;
  });

  return out;
}

/**
 * 章节 → 学习单元。
 *
 * 只取叶子节点：有子节的章，其分钟数由子节承担，避免「章 300 分钟 + 节各 60 分钟」
 * 双份计时。若整份目录没有父子关系，则全部视为叶子。
 *
 * 超长单元按 unitMinutes 拆分，标题加「（1/3）」后缀，保证每块都能塞进一个番茄钟。
 */
export function chaptersToUnits(
  chapters: NormalizedChapter[],
  unitMinutes: number,
): StudyUnit[] {
  const parentNos = new Set<number>();
  for (const c of chapters) {
    if (c.parent_no !== null) parentNos.add(c.parent_no);
  }
  const leaves = chapters.filter(
    (c) => !(c.parent_no === null && parentNos.has(c.no)),
  );
  const list = leaves.length > 0 ? leaves : chapters;

  const safeUnit = Math.max(15, roundMinutes(unitMinutes));
  const units: StudyUnit[] = [];
  let seq = 1;

  for (const chapter of list) {
    const total = chapter.minutes;
    const parts =
      total > safeUnit * SPLIT_ABOVE_FACTOR
        ? Math.ceil(total / safeUnit)
        : 1;
    const perPart = roundMinutes(total / parts);

    // 页数跟着一起拆：整章 40 页拆 3 段 → 13/13/14 页，前端看到的仍是「这节大概几页」
    const totalPages = chapter.pages;
    const perPartPages =
      totalPages !== null && parts > 1
        ? Math.max(1, Math.round(totalPages / parts))
        : totalPages;

    for (let i = 0; i < parts; i++) {
      const isLast = i === parts - 1;
      // 最后一段吃掉余数，避免各段相加后与总时长偏差过大
      const minutes = isLast ? roundMinutes(total - perPart * (parts - 1)) : perPart;
      const pages =
        totalPages === null || perPartPages === null
          ? null
          : isLast
            ? Math.max(1, totalPages - perPartPages * (parts - 1))
            : perPartPages;
      const title =
        parts > 1
          ? `${chapter.title}（${i + 1}/${parts}）`
          : chapter.title;
      units.push({
        seq: seq++,
        title: title.slice(0, 255),
        chapter_no: chapter.no,
        minutes: Math.max(10, minutes),
        pages,
        difficulty: chapter.difficulty,
      });
    }
  }

  return units;
}

/** 学习单元 → 待办标题：「离散数学 · 1.1 命题逻辑（1/2）」 */
export function unitTodoTitle(params: {
  bookTitle: string;
  unitTitle: string;
  seq?: number;
  total?: number;
}): string {
  const book = (params.bookTitle || "").trim();
  const unit = (params.unitTitle || "").trim();
  const prefix = book ? `${book} · ` : "";
  return `${prefix}${unit}`.slice(0, 255);
}

/** 学习单元 → 待办描述 */
export function unitTodoDescription(params: {
  bookTitle: string;
  chapterNo: number | null;
  minutes: number;
  seq: number;
  total: number;
  pages?: number | null;
  difficulty?: number | null;
}): string {
  const lines = [
    `来自学习计划：${params.bookTitle}`,
    `本次学习 ${params.minutes} 分钟（进度 ${params.seq}/${params.total}）`,
  ];
  if (params.pages) {
    const diffLabel =
      params.difficulty === 3
        ? "证明/计算型"
        : params.difficulty === 1
          ? "概念型"
          : "普通";
    lines.push(`内容量：约 ${params.pages} 页（${diffLabel}）`);
  }
  if (params.chapterNo !== null) lines.push(`对应章节序号：${params.chapterNo}`);
  lines.push("完成后把这条待办标记完成，学习计划的进度会自动更新。");
  return lines.join("\n");
}

/** 把「按天分组」的结果整理成前端直接可渲染的紧凑结构 */
export function groupSlotsByDate<
  T extends { date: string; minutes: number },
>(slots: T[]): Array<{ date: string; minutes: number; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const s of slots) {
    const arr = map.get(s.date) ?? [];
    arr.push(s);
    map.set(s.date, arr);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, items]) => ({
      date,
      minutes: items.reduce((s, i) => s + i.minutes, 0),
      items,
    }));
}
