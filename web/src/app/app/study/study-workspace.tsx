"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AiApiError,
  applyStudyPlan,
  deleteStudyPlan,
  DEFAULT_MIN_PER_PAGE,
  DIFFICULTY_LABEL,
  estimateChapterMinutes,
  getStudyCalibration,
  getStudyPlan,
  listStudyPlans,
  previewStudyPlan,
  saveStudyItemActual,
  studyOutline,
  type StudyCalibration,
  type StudyChapter,
  type StudyOutline,
  type StudyPlanDetail,
  type StudyPlanMeta,
  type StudyPlanPreview,
} from "@/lib/ai-api";
import type { SpaceNavItem } from "@/lib/todos";
import { chipClass, primaryBtnClass, secondaryBtnClass, secondaryPillClass } from "../ui-btn-class";

type Props = {
  spaces: SpaceNavItem[];
};

type Step = 1 | 2 | 3 | 4;
type SourceType = "book" | "text" | "feishu";

const TZ = "Asia/Shanghai";
const STEP_LABEL = ["选来源", "核对目录", "排期参数", "预览确认"];
const WEEK_LABEL = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const UNIT_OPTIONS = [25, 30, 45, 60, 90];
const SOURCE_LABEL: Record<string, string> = {
  book: "豆瓣目录",
  text: "粘贴目录",
  feishu: "飞书文档",
  ai: "AI 草案",
};
const STATUS_LABEL: Record<string, string> = {
  planned: "待确认",
  applied: "已生成待办",
  archived: "已归档",
};

const timeFmt = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function errText(e: unknown): string {
  if (e instanceof AiApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "未知错误";
}

function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function fmtMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} 分钟`;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return timeFmt.format(d);
}

function fmtDay(dateKey: string): string {
  const parts = dateKey.split("-");
  if (parts.length < 3) return dateKey;
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

function weekdayOf(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return WEEK_LABEL[(d.getUTCDay() + 6) % 7];
}

function pct(done: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/** "20:00" → 1200（分钟）。解析失败返回 0。 */
function hhmmToMinutes(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 按「每页分钟」重算一行的分钟数（与后端 estimateMinutes 一致）。
 * 没有页数的老数据原样返回，保留用户手动填的分钟数。
 */
function recomputeChapter(c: StudyChapter, speed: number): StudyChapter {
  if (!c.pages) return c;
  return { ...c, minutes: estimateChapterMinutes(c.pages, c.difficulty, speed) };
}

/** 整份目录按新速度重算 */
function recomputeAll(list: StudyChapter[], speed: number): StudyChapter[] {
  return list.map((c) => recomputeChapter(c, speed));
}

/**
 * 只有「最下层章节」会被排进日历（与后端 chaptersToUnits 同规则）：
 * 若某一行的编号出现在别人的 parent_no 里，它就是父节点，不参与排期。
 */
function pickLeafChapters(list: StudyChapter[]): StudyChapter[] {
  const parentNos = new Set<number>();
  for (const c of list) {
    if (c.parent_no !== null && c.parent_no !== undefined) parentNos.add(c.parent_no);
  }
  const leaves = list.filter((c) => {
    if (c.parent_no !== null && c.parent_no !== undefined) return true;
    if (c.no === null || c.no === undefined) return true;
    return !parentNos.has(c.no);
  });
  return leaves.length > 0 ? leaves : list;
}

export function StudyWorkspace({ spaces }: Props) {
  const [tab, setTab] = useState<"new" | "mine">("new");
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ① 来源
  const [srcType, setSrcType] = useState<SourceType>("book");
  const [bookTitle, setBookTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [outlineBusy, setOutlineBusy] = useState(false);

  // ② 目录
  const [step, setStep] = useState<Step>(1);
  const [outline, setOutline] = useState<StudyOutline | null>(null);
  const [chapters, setChapters] = useState<StudyChapter[]>([]);

  // ③ 参数
  const [dailyStart, setDailyStart] = useState("20:00");
  const [dailyEnd, setDailyEnd] = useState("21:30");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startDate, setStartDate] = useState("");
  const [deadline, setDeadline] = useState("");
  const [unitMinutes, setUnitMinutes] = useState(45);
  /** 每页多少分钟 —— 唯一的估时校准旋钮，改它整份目录立刻重算 */
  const [minPerPage, setMinPerPage] = useState(DEFAULT_MIN_PER_PAGE);

  // ④ 预览
  const [preview, setPreview] = useState<StudyPlanPreview | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  // 我的计划
  const [plans, setPlans] = useState<StudyPlanMeta[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StudyPlanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 删除计划：待确认的计划 + 是否连带删掉已生成的待办
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteWithTodos, setDeleteWithTodos] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    setStartDate((prev) => prev || todayKey());
  }, []);

  const loadPlans = useCallback(async (sid: string) => {
    if (!sid) return;
    setPlansLoading(true);
    try {
      const { plans: list } = await listStudyPlans(sid);
      setPlans(list ?? []);
    } catch (e) {
      setError(errText(e));
    } finally {
      setPlansLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlans(spaceId);
  }, [spaceId, loadPlans]);

  // 只统计会被真正排期的行（叶子章节），避免把章级时长重复算进去
  const leafStats = useMemo(() => {
    const leaves = pickLeafChapters(chapters);
    return {
      count: leaves.length,
      minutes: leaves.reduce((s, c) => s + (Number(c.minutes) || 0), 0),
      pages: leaves.reduce((s, c) => s + (Number(c.pages) || 0), 0),
      unknownPages: leaves.filter((c) => !c.pages).length,
    };
  }, [chapters]);

  // 按「每天窗口 ÷ 单块时长」估算需要几周（与后端装箱口径一致）
  const estWeeks = useMemo(() => {
    const unit = Math.max(15, Math.round(unitMinutes) || 45);
    const windowMin = hhmmToMinutes(dailyEnd) - hhmmToMinutes(dailyStart);
    const perDay = Math.max(1, Math.floor(windowMin / unit));
    const perWeek = perDay * Math.max(1, weekdays.length);
    return Math.max(1, Math.ceil(leafStats.minutes / unit / perWeek));
  }, [dailyEnd, dailyStart, leafStats.minutes, unitMinutes, weekdays.length]);

  async function handleOutline() {
    if (!spaceId) return;
    setError(null);
    setNotice(null);
    if (srcType === "book" && !bookTitle.trim()) {
      setError("请先填写书名");
      return;
    }
    if (srcType === "text" && text.trim().length < 10) {
      setError("目录文本太短，至少复制几个章节标题进来");
      return;
    }
    if (srcType === "feishu" && !url.trim()) {
      setError("请填写飞书文档链接");
      return;
    }

    setOutlineBusy(true);
    try {
      const res = await studyOutline({
        space_id: spaceId,
        source: srcType,
        min_per_page: minPerPage,
        ...(srcType === "book"
          ? {
              book_title: bookTitle.trim(),
              ...(author.trim() ? { author: author.trim() } : {}),
            }
          : {}),
        ...(srcType === "text"
          ? {
              text,
              ...(bookTitle.trim() ? { book_title: bookTitle.trim() } : {}),
            }
          : {}),
        ...(srcType === "feishu"
          ? {
              url: url.trim(),
              ...(bookTitle.trim() ? { book_title: bookTitle.trim() } : {}),
            }
          : {}),
      });
      setOutline(res);
      setChapters(res.chapters);
      if (res.book_title && !bookTitle.trim()) setBookTitle(res.book_title);
      setPreview(null);
      setAppliedCount(null);
      setStep(2);
    } catch (e) {
      setError(errText(e));
    } finally {
      setOutlineBusy(false);
    }
  }

  async function handlePlan() {
    if (!spaceId) return;
    const clean = chapters
      .map((c) => {
        const base = {
          ...c,
          title: (c.title || "").trim(),
        };
        // 有页数：后端会按公式重算，这里先算一遍让预览数字一致；没页数：用用户手填的分钟
        return {
          ...base,
          minutes: base.pages
            ? estimateChapterMinutes(base.pages, base.difficulty, minPerPage)
            : Math.max(5, Math.round(Number(c.minutes) || 0)),
        };
      })
      .filter((c) => c.title.length > 0);
    if (clean.length === 0) {
      setError("目录至少要有一条有效章节");
      return;
    }
    if (weekdays.length === 0) {
      setError("至少选择一天可学习");
      return;
    }

    setError(null);
    setNotice(null);
    setPlanBusy(true);
    try {
      const res = await previewStudyPlan({
        space_id: spaceId,
        book_title: bookTitle.trim() || outline?.book_title || "未命名教材",
        chapters: clean,
        source_type:
          outline && outline.source !== "ai"
            ? (outline.source as SourceType)
            : "text",
        source_url: outline?.source_url ?? null,
        outline_meta: {
          note: outline?.note ?? "",
          confidence: outline?.confidence ?? "high",
          original_chapter_count: chapters.length,
        },
        daily_start: dailyStart,
        daily_end: dailyEnd,
        weekdays,
        start_date: startDate || todayKey(),
        deadline: deadline || null,
        unit_minutes: unitMinutes,
        min_per_page: minPerPage,
        timezone: TZ,
      });
      setPreview(res);
      setAppliedCount(null);
      setStep(4);
      void loadPlans(spaceId);
    } catch (e) {
      setError(errText(e));
    } finally {
      setPlanBusy(false);
    }
  }

  async function handleApply() {
    if (!spaceId || !preview) return;
    setError(null);
    setApplyBusy(true);
    try {
      const res = await applyStudyPlan({
        space_id: spaceId,
        plan_id: preview.plan.id,
      });
      setAppliedCount(res.todo_count);
      setNotice(`已生成 ${res.todo_count} 条待办，去日历就能看到它们`);
      void loadPlans(spaceId);
    } catch (e) {
      setError(errText(e));
    } finally {
      setApplyBusy(false);
    }
  }

  function resetNew() {
    setStep(1);
    setOutline(null);
    setChapters([]);
    setPreview(null);
    setAppliedCount(null);
    setError(null);
    setNotice(null);
  }

  async function handleDeletePlan(p: StudyPlanMeta) {
    setError(null);
    setDeleteBusy(true);
    try {
      const withTodos = deleteWithTodos && p.status === "applied";
      const res = await deleteStudyPlan(p.id, withTodos);
      if (openPlanId === p.id) {
        setOpenPlanId(null);
        setDetail(null);
      }
      setConfirmDeleteId(null);
      setDeleteWithTodos(false);
      setNotice(
        res.todo_deleted > 0
          ? `已删除计划「${res.book_title}」，同时删掉 ${res.todo_deleted} 条待办`
          : `已删除计划「${res.book_title}」`,
      );
      void loadPlans(spaceId);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function openPlan(id: string) {
    if (openPlanId === id) {
      setOpenPlanId(null);
      setDetail(null);
      return;
    }
    setOpenPlanId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await getStudyPlan(id);
      setDetail(res);
    } catch (e) {
      setError(errText(e));
      setOpenPlanId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  if (spaces.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <p className="text-sm text-[var(--text-muted)]">
          还没有可用的空间，请先创建或加入一个空间。
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[var(--brand-ink)]">学习计划</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            把一本书的目录切成学习块，自动铺进你的日历 —— AI 只估时长，排期是算出来的，改参数秒级重排。
          </p>
        </div>
        <select
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
          className="rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
        >
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTab("new")}
          className={secondaryPillClass(tab === "new")}
        >
          新建计划
        </button>
        <button
          type="button"
          onClick={() => setTab("mine")}
          className={secondaryPillClass(tab === "mine")}
        >
          我的计划{plans.length > 0 ? `（${plans.length}）` : ""}
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      ) : null}

      {tab === "new" ? (
        <>
          <ol className="mt-5 flex flex-wrap items-center gap-2 text-xs">
            {STEP_LABEL.map((label, i) => {
              const n = (i + 1) as Step;
              const active = step === n;
              const done = step > n;
              return (
                <li key={label} className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={n >= step}
                    onClick={() => setStep(n)}
                    className={[
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors duration-200",
                      active
                        ? "bg-brand-soft font-semibold text-brand"
                        : done
                          ? "text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
                          : "text-[var(--text-muted)]",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                        active
                          ? "bg-[#185FA5] text-white"
                          : done
                            ? "bg-[#185FA5]/15 text-brand"
                            : "bg-[var(--surface-muted)] text-[var(--text-muted)]",
                      ].join(" ")}
                    >
                      {done ? "✓" : n}
                    </span>
                    {label}
                  </button>
                  {i < STEP_LABEL.length - 1 ? (
                    <span className="h-px w-4 bg-[var(--border-muted)]" />
                  ) : null}
                </li>
              );
            })}
          </ol>

          {/* ① 选来源 */}
          {step === 1 ? (
            <section className="mt-4 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
              <h2 className="text-sm font-semibold text-[var(--brand-ink)]">目录来源</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {(["book", "text", "feishu"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setSrcType(t)}
                    className={chipClass(srcType === t)}
                  >
                    {t === "book" ? "只给书名" : t === "text" ? "粘贴目录" : "飞书文档"}
                  </button>
                ))}
              </div>

              <div className="mt-4 space-y-2">
                {srcType === "book" ? (
                  <>
                    <input
                      type="text"
                      value={bookTitle}
                      onChange={(e) => setBookTitle(e.target.value)}
                      placeholder="书名，例如：离散数学及其应用"
                      className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                    <input
                      type="text"
                      value={author}
                      onChange={(e) => setAuthor(e.target.value)}
                      placeholder="作者（可选，建议填，能避免抓到别的版次）"
                      className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                    <p className="text-xs text-[var(--text-muted)]">
                      会先去豆瓣抓真实目录；抓不到时用 AI 生成草案（会标成橙色待核对）。
                    </p>
                  </>
                ) : null}

                {srcType === "text" ? (
                  <>
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={10}
                      placeholder={"把目录整段粘进来，一行一章，例如：\n第1章 逻辑与证明\n1.1 命题逻辑\n1.2 谓词逻辑"}
                      className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                    <input
                      type="text"
                      value={bookTitle}
                      onChange={(e) => setBookTitle(e.target.value)}
                      placeholder="书名（可选，用于待办标题）"
                      className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                  </>
                ) : null}

                {srcType === "feishu" ? (
                  <>
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="飞书文档链接 https://…/docx/… 或 /wiki/…"
                      className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                    <input
                      type="text"
                      value={bookTitle}
                      onChange={(e) => setBookTitle(e.target.value)}
                      placeholder="书名（可选，留空用文档标题）"
                      className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                  </>
                ) : null}
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={handleOutline}
                  disabled={outlineBusy}
                  className={primaryBtnClass()}
                >
                  {outlineBusy ? "解析中…" : "解析目录"}
                </button>
              </div>
            </section>
          ) : null}

          {/* ② 核对目录 */}
          {step === 2 && outline ? (
            <section className="mt-4 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-[var(--brand-ink)]">
                    {bookTitle || outline.book_title}
                  </h2>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    <span className="mr-2 rounded-full bg-[var(--surface-muted)] px-2 py-0.5">
                      {SOURCE_LABEL[outline.source] ?? outline.source}
                    </span>
                    {chapters.length} 项 · 可排 {leafStats.count} 个 · 合计{" "}
                    {fmtMinutes(leafStats.minutes)}
                    {outline.source_url ? (
                      <a
                        href={outline.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 underline decoration-dotted"
                      >
                        查看来源
                      </a>
                    ) : null}
                  </p>
                </div>
                <span
                  className={[
                    "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                    outline.confidence === "high"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700",
                  ].join(" ")}
                >
                  {outline.confidence === "high" ? "来源可信" : "需要核对"}
                </span>
              </div>

              {outline.note ? (
                <p
                  className={[
                    "mt-3 rounded-xl px-3 py-2 text-xs",
                    outline.needs_review
                      ? "border border-amber-200 bg-amber-50 text-amber-800"
                      : "bg-[var(--surface-muted)] text-[var(--text-muted)]",
                  ].join(" ")}
                >
                  {outline.note}
                </p>
              ) : null}

              <p className="mt-3 text-xs text-[var(--text-muted)]">
                排期只算「最下层章节」—— 同时有章和节时，章级的时长不参与，避免重复计时。估时不再由 AI 直接给，而是
                <b className="text-[var(--brand-ink)]"> 页数 × 每页分钟 × 难度系数 </b>
                算出来的，所以只要校准「我一页要几分钟」这一个数就行。
              </p>

              {/* 估时口径：唯一的校准旋钮 */}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-[var(--surface-muted)] px-3 py-2">
                <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  我一页要
                  <input
                    type="number"
                    min={1}
                    max={20}
                    step={0.5}
                    value={minPerPage}
                    onChange={(e) => {
                      const v = Math.min(20, Math.max(1, Number(e.target.value) || DEFAULT_MIN_PER_PAGE));
                      setMinPerPage(v);
                      setChapters((prev) => recomputeAll(prev, v));
                    }}
                    className="w-16 rounded-lg border border-[var(--border-muted)] bg-white px-2 py-1 text-right text-sm tabular-nums text-[var(--brand-ink)] outline-none focus:border-brand"
                  />
                  分钟
                </label>
                <span className="text-xs text-[var(--text-muted)]">
                  可排 {leafStats.count} 项 · 共 {leafStats.pages || "?"} 页 · 估{" "}
                  {fmtMinutes(leafStats.minutes)}
                </span>
                {leafStats.unknownPages > 0 ? (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                    {leafStats.unknownPages} 项没有页数，按手填分钟算
                  </span>
                ) : null}
              </div>

              <div className="mt-3 max-h-[420px] overflow-y-auto rounded-xl border border-[var(--border-muted)]">
                {chapters.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 border-b border-[var(--border-muted)] px-2 py-1.5 last:border-b-0"
                  >
                    <span
                      className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]"
                      style={{ width: 26 }}
                    >
                      {c.no ?? i + 1}
                    </span>
                    <input
                      type="text"
                      value={c.title}
                      onChange={(e) =>
                        setChapters((prev) =>
                          prev.map((x, k) =>
                            k === i ? { ...x, title: e.target.value } : x,
                          ),
                        )
                      }
                      style={{ paddingLeft: ((c.level ?? 1) - 1) * 12 + 8 }}
                      className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent py-1 text-sm text-[var(--brand-ink)] outline-none hover:border-[var(--border-muted)] focus:border-brand"
                    />
                    <input
                      type="number"
                      min={1}
                      max={2000}
                      step={1}
                      value={c.pages ?? ""}
                      placeholder="—"
                      title="这一项在教材上大约多少页"
                      onChange={(e) =>
                        setChapters((prev) =>
                          prev.map((x, k) =>
                            k === i
                              ? recomputeChapter(
                                  {
                                    ...x,
                                    pages: e.target.value ? Number(e.target.value) : null,
                                    difficulty: x.difficulty ?? 2,
                                  },
                                  minPerPage,
                                )
                              : x,
                          ),
                        )
                      }
                      className="w-14 shrink-0 rounded-lg border border-[var(--border-muted)] px-2 py-1 text-right text-sm tabular-nums text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">页</span>
                    <select
                      value={c.difficulty ?? 2}
                      disabled={!c.pages}
                      title="难度决定每页耗时系数"
                      onChange={(e) =>
                        setChapters((prev) =>
                          prev.map((x, k) =>
                            k === i
                              ? recomputeChapter(
                                  { ...x, difficulty: Number(e.target.value) },
                                  minPerPage,
                                )
                              : x,
                          ),
                        )
                      }
                      className="w-24 shrink-0 rounded-lg border border-[var(--border-muted)] bg-white px-1 py-1 text-xs text-[var(--brand-ink)] outline-none focus:border-brand disabled:bg-[var(--surface-muted)] disabled:text-[var(--text-muted)]"
                    >
                      {[1, 2, 3].map((d) => (
                        <option key={d} value={d}>
                          {DIFFICULTY_LABEL[d]}
                        </option>
                      ))}
                    </select>
                    {c.pages ? (
                      <span className="w-16 shrink-0 text-right text-sm tabular-nums text-[var(--text-muted)]">
                        {c.minutes} 分
                      </span>
                    ) : (
                      <>
                        <input
                          type="number"
                          min={5}
                          step={5}
                          value={c.minutes}
                          title="没有页数时手填分钟数"
                          onChange={(e) =>
                            setChapters((prev) =>
                              prev.map((x, k) =>
                                k === i
                                  ? { ...x, minutes: Number(e.target.value) || 0 }
                                  : x,
                              ),
                            )
                          }
                          className="w-16 shrink-0 rounded-lg border border-[var(--border-muted)] px-2 py-1 text-right text-sm tabular-nums text-[var(--brand-ink)] outline-none focus:border-brand"
                        />
                        <span className="w-6 shrink-0 text-xs text-[var(--text-muted)]">分</span>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setChapters((prev) => prev.filter((_, k) => k !== i))
                      }
                      className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-red-50 hover:text-red-600"
                    >
                      删除
                    </button>
                  </div>
                ))}
                {chapters.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">
                    目录已清空，点下面「添加一行」重新开始。
                  </p>
                ) : null}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      setChapters((prev) => [
                        ...prev,
                        {
                          no: prev.length + 1,
                          title: "",
                          level: 1,
                          parent_no: null,
                          pages: 10,
                          difficulty: 2,
                          minutes: estimateChapterMinutes(10, 2, minPerPage),
                        },
                      ])
                    }
                    className={secondaryBtnClass()}
                  >
                    添加一行
                  </button>
                  <span className="text-xs text-[var(--text-muted)]">
                    {chapters.length} 项 · 可排 {leafStats.count} 个 · 合计{" "}
                    {fmtMinutes(leafStats.minutes)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className={secondaryBtnClass()}
                  >
                    上一步
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    disabled={chapters.length === 0}
                    className={primaryBtnClass()}
                  >
                    下一步：排期参数
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {/* ③ 排期参数 */}
          {step === 3 ? (
            <section className="mt-4 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
              <h2 className="text-sm font-semibold text-[var(--brand-ink)]">排期参数</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                排期会避开日历上已有的安排，只在空闲时段里铺学习块。
              </p>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                    每天可用窗口
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={dailyStart}
                      onChange={(e) => setDailyStart(e.target.value)}
                      className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                    <span className="text-sm text-[var(--text-muted)]">—</span>
                    <input
                      type="time"
                      value={dailyEnd}
                      onChange={(e) => setDailyEnd(e.target.value)}
                      className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                    />
                  </div>
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                    单个学习块时长
                  </span>
                  <select
                    value={unitMinutes}
                    onChange={(e) => setUnitMinutes(Number(e.target.value))}
                    className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                  >
                    {UNIT_OPTIONS.map((v) => (
                      <option key={v} value={v}>
                        {v} 分钟
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                    起始日期
                  </span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                    截止日期（可选）
                  </span>
                  <input
                    type="date"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
                  />
                </label>
              </div>

              <div className="mt-4">
                <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                  每周可学日
                </span>
                <div className="flex flex-wrap gap-2">
                  {WEEK_LABEL.map((label, i) => {
                    const day = i + 1;
                    const active = weekdays.includes(day);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          setWeekdays((prev) =>
                            prev.includes(day)
                              ? prev.filter((d) => d !== day)
                              : [...prev, day].sort((a, b) => a - b),
                          )
                        }
                        className={chipClass(active)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[var(--text-muted)]">
                  可排合计 {fmtMinutes(leafStats.minutes)}，约需 {estWeeks}{" "}
                  周
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(2)}
                    className={secondaryBtnClass()}
                  >
                    上一步
                  </button>
                  <button
                    type="button"
                    onClick={handlePlan}
                    disabled={planBusy}
                    className={primaryBtnClass()}
                  >
                    {planBusy ? "排期中…" : "生成排期预览"}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {/* ④ 预览确认 */}
          {step === 4 && preview ? (
            <section className="mt-4 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="text-sm font-semibold text-[var(--brand-ink)]">
                  {preview.plan.book_title}
                </h2>
                <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                  预览 · 还没写进日历
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["总时长", fmtMinutes(preview.plan.summary.total_minutes)],
                  ["学习块", `${preview.plan.summary.total_units} 个`],
                  ["需要天数", `${preview.plan.summary.days_needed} 天`],
                  ["日均", `${preview.plan.summary.daily_avg_minutes} 分钟`],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded-xl bg-[var(--surface-muted)] px-3 py-2"
                  >
                    <p className="text-xs text-[var(--text-muted)]">{k}</p>
                    <p className="mt-0.5 text-sm font-semibold text-[var(--brand-ink)]">{v}</p>
                  </div>
                ))}
              </div>

              <p className="mt-2 text-xs text-[var(--text-muted)]">
                {preview.plan.summary.start_date}
                {preview.plan.summary.end_date ? ` ~ ${preview.plan.summary.end_date}` : ""}
                {"（按 "}
                {preview.plan.params.weekdays.map((d) => WEEK_LABEL[d - 1]).join("、")}
                {` 排，每天 ${preview.plan.params.daily_start}–${preview.plan.params.daily_end}）`}
              </p>

              {preview.plan.summary.deadline_fit ? (
                <div
                  className={[
                    "mt-3 rounded-xl border px-3 py-2 text-xs",
                    preview.plan.summary.deadline_fit.feasible
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  ].join(" ")}
                >
                  {preview.plan.summary.deadline_fit.feasible ? (
                    <>
                      截止日 {preview.plan.summary.deadline_fit.deadline} 能学完，还剩{" "}
                      {fmtMinutes(
                        preview.plan.summary.deadline_fit.capacity_minutes -
                          preview.plan.summary.total_minutes,
                      )}{" "}
                      余量。
                    </>
                  ) : (
                    <>
                      截止日 {preview.plan.summary.deadline_fit.deadline} 前只能学{" "}
                      {fmtMinutes(preview.plan.summary.deadline_fit.capacity_minutes)}，
                      还差 {fmtMinutes(preview.plan.summary.deadline_fit.deficit_minutes)}；
                      要么每天多学 {preview.plan.summary.deadline_fit.extra_per_day} 分钟，
                      要么放宽截止日。
                    </>
                  )}
                </div>
              ) : null}

              {preview.warnings.length > 0 ? (
                <ul className="mt-3 space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {preview.warnings.slice(0, 6).map((w) => (
                    <li key={w}>· {w}</li>
                  ))}
                </ul>
              ) : null}

              <div className="mt-3 max-h-[380px] overflow-y-auto rounded-xl border border-[var(--border-muted)]">
                {preview.days.map((d) => (
                  <div
                    key={d.date}
                    className="border-b border-[var(--border-muted)] px-3 py-2 last:border-b-0"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-[var(--brand-ink)]">
                        {fmtDay(d.date)}
                        <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">
                          {weekdayOf(d.date)}
                        </span>
                      </p>
                      <span className="text-xs text-[var(--text-muted)]">
                        {d.minutes} 分钟
                      </span>
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {d.items.map((it) => (
                        <li key={it.seq} className="flex items-center gap-2 text-xs">
                          <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                            {fmtTime(it.start_at)}–{fmtTime(it.end_at)}
                          </span>
                          <span className="min-w-0 truncate text-[var(--brand-ink)]">
                            {it.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {preview.days.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">
                    一个学习块都没排上，检查一下可用窗口和可学日。
                  </p>
                ) : null}
              </div>

              {preview.unplaced.length > 0 ? (
                <div className="mt-3 rounded-xl border border-[var(--border-muted)] px-3 py-2">
                  <p className="text-xs font-medium text-[var(--brand-ink)]">
                    没排上的 {preview.unplaced.length} 项（窗口不够，可加长每日时间或放宽截止日）
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {preview.unplaced.slice(0, 10).map((u) => (
                      <li key={u.seq} className="text-xs text-[var(--text-muted)]">
                        · {u.title}（{u.minutes} 分钟）
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {appliedCount !== null ? (
                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  已生成 {appliedCount} 条待办。
                  <button
                    type="button"
                    onClick={() => setTab("mine")}
                    className="ml-2 underline decoration-dotted"
                  >
                    去我的计划看进度
                  </button>
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className={secondaryBtnClass()}
                  disabled={appliedCount !== null}
                >
                  改参数重排
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={resetNew}
                    className={secondaryBtnClass()}
                  >
                    重新开始
                  </button>
                  <button
                    type="button"
                    onClick={handleApply}
                    disabled={applyBusy || appliedCount !== null || preview.days.length === 0}
                    className={primaryBtnClass()}
                  >
                    {appliedCount !== null
                      ? "已生成"
                      : applyBusy
                        ? "写入中…"
                        : "确认生成待办"}
                  </button>
                </div>
              </div>
              <p className="mt-2 text-right text-[11px] text-[var(--text-muted)]">
                每次「生成排期预览」都会存一条草稿计划，改参数重排不会覆盖旧草稿。
              </p>
            </section>
          ) : null}
        </>
      ) : (
        /* 我的计划 */
        <section className="mt-4 space-y-3">
          {plansLoading && plans.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">加载计划…</p>
          ) : plans.length === 0 ? (
            <div className="rounded-2xl border border-[var(--border-muted)] bg-white px-4 py-8 text-center">
              <p className="text-sm text-[var(--text-muted)]">
                还没有学习计划，去「新建计划」建一个。
              </p>
            </div>
          ) : (
            plans.map((p) => {
              const percent = pct(p.progress.done_minutes, p.progress.total_minutes);
              const open = openPlanId === p.id;
              const confirming = confirmDeleteId === p.id;
              const generatedTodos = p.status === "applied" ? p.progress.total_units : 0;
              return (
                <div
                  key={p.id}
                  className="rounded-2xl border border-[var(--border-muted)] bg-white"
                >
                  <div className="flex items-start gap-2 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => void openPlan(p.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--brand-ink)]">
                            {p.book_title}
                          </p>
                          <p className="mt-1 text-xs text-[var(--text-muted)]">
                            {STATUS_LABEL[p.status] ?? p.status} · {p.progress.total_units} 个学习块 ·{" "}
                            {fmtMinutes(p.summary.total_minutes)} · 日均 {p.summary.daily_avg_minutes} 分钟
                          </p>
                          <p className="text-xs text-[var(--text-muted)]">
                            {p.summary.start_date}
                            {p.summary.end_date ? ` ~ ${p.summary.end_date}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-semibold text-[var(--brand-ink)]">
                            {percent}%
                          </p>
                          <p className="text-xs text-[var(--text-muted)]">
                            {p.progress.done_units}/{p.progress.total_units} 块
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]">
                        <div
                          className="h-full rounded-full bg-[#185FA5] transition-all duration-300"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(confirming ? null : p.id);
                        setDeleteWithTodos(true);
                      }}
                      className="mt-0.5 shrink-0 rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-600 transition-colors duration-200 hover:bg-red-50"
                    >
                      删除
                    </button>
                  </div>

                  {confirming ? (
                    <div className="border-t border-[var(--border-muted)] bg-red-50/60 px-4 py-3">
                      <p className="text-xs text-red-600">
                        确定删除「{p.book_title}」？计划本身不可恢复。
                      </p>
                      {generatedTodos > 0 ? (
                        <label className="mt-2 flex items-start gap-2 text-xs text-[var(--brand-ink)]">
                          <input
                            type="checkbox"
                            checked={deleteWithTodos}
                            onChange={(e) => setDeleteWithTodos(e.target.checked)}
                            className="mt-0.5 accent-red-600"
                          />
                          <span>
                            同时删除已生成的 {generatedTodos} 条待办；不勾选则待办留在日历里，可以单独删。
                          </span>
                        </label>
                      ) : null}
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleDeletePlan(p)}
                          disabled={deleteBusy}
                          className="rounded-xl bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-red-700 disabled:opacity-50"
                        >
                          {deleteBusy ? "删除中…" : "确认删除"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={deleteBusy}
                          className="rounded-xl border border-[#2f5f8f]/55 bg-white px-3 py-1.5 text-xs font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7] disabled:opacity-50"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {open ? (
                    <div className="border-t border-[var(--border-muted)] px-4 py-3">
                      {detailLoading ? (
                        <p className="text-sm text-[var(--text-muted)]">加载详情…</p>
                      ) : detail && detail.plan.id === p.id ? (
                        <PlanDetail detail={detail} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </section>
      )}
    </div>
  );
}

/** 计划详情：按天列学习块，勾掉的是已完成；已完成的块可以填真实用时，用来校准「每页分钟」 */
function PlanDetail({ detail }: { detail: StudyPlanDetail }) {
  const unplaced = detail.items.filter((i) => !i.scheduled_start);

  // 实际用时：输入框草稿 + 已保存值（保存后立刻刷新校准，不用手动刷新页面）
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // 校准报告：后端按「整个空间所有计划」汇总，样本比单计划更足、口径唯一
  const [calibration, setCalibration] = useState<StudyCalibration | null>(null);

  const actualOf = useCallback(
    (id: string, fallback: number | null | undefined) =>
      saved[id] ?? (fallback ?? null),
    [saved],
  );

  const loadCalibration = useCallback(async () => {
    const sid = detail.plan.space_id;
    if (!sid) return;
    try {
      setCalibration(await getStudyCalibration(sid));
    } catch {
      // 校准拉取失败不阻断详情展示，静默保留上一次结果
    }
  }, [detail.plan.space_id]);

  useEffect(() => {
    setCalibration(null);
    void loadCalibration();
  }, [loadCalibration]);

  async function saveActual(id: string) {
    const raw = Number(draft[id]);
    if (!Number.isFinite(raw) || raw <= 0) return;
    setBusyId(id);
    setSaveErr(null);
    try {
      await saveStudyItemActual(id, Math.round(raw));
      setSaved((prev) => ({ ...prev, [id]: Math.round(raw) }));
      void loadCalibration();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <p className="text-xs text-[var(--text-muted)]">
        {detail.plan.summary.days_needed} 天 · {detail.plan.summary.total_units} 个学习块 ·{" "}
        {fmtMinutes(detail.plan.summary.total_minutes)}
        {detail.plan.summary.deadline_fit && !detail.plan.summary.deadline_fit.feasible
          ? ` · 截止日差 ${fmtMinutes(detail.plan.summary.deadline_fit.deficit_minutes)}`
          : ""}
      </p>

      <div className="mt-2 max-h-[360px] overflow-y-auto rounded-xl border border-[var(--border-muted)]">
        {detail.days.map((d) => (
          <div
            key={d.date}
            className="border-b border-[var(--border-muted)] px-3 py-2 last:border-b-0"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-[var(--brand-ink)]">
                {fmtDay(d.date)}
                <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">
                  {weekdayOf(d.date)}
                </span>
              </p>
              <span className="text-xs text-[var(--text-muted)]">{d.minutes} 分钟</span>
            </div>
            <ul className="mt-1 space-y-0.5">
              {d.items.map((it) => {
                const done = it.status === "done";
                const savedActual = actualOf(it.id, it.actual_minutes);
                return (
                  <li key={it.id} className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                      {fmtTime(it.start_at)}–{fmtTime(it.end_at)}
                    </span>
                    <span
                      className={[
                        "min-w-0 flex-1 truncate",
                        done
                          ? "text-[var(--text-muted)] line-through"
                          : "text-[var(--brand-ink)]",
                      ].join(" ")}
                    >
                      {it.title}
                    </span>
                    {it.pages ? (
                      <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                        {it.pages}页
                      </span>
                    ) : null}
                    {done ? (
                      <>
                        <span className="shrink-0 text-emerald-600">✓</span>
                        <input
                          type="number"
                          min={1}
                          max={1440}
                          step={5}
                          placeholder={savedActual ? String(savedActual) : "实际分"}
                          value={draft[it.id] ?? ""}
                          title="这一块你实际学了多久（分钟）"
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, [it.id]: e.target.value }))
                          }
                          onBlur={() => void saveActual(it.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveActual(it.id);
                          }}
                          className="w-16 shrink-0 rounded-lg border border-[var(--border-muted)] px-1.5 py-0.5 text-right tabular-nums text-[var(--brand-ink)] outline-none focus:border-brand"
                        />
                        {busyId === it.id ? (
                          <span className="shrink-0 text-[var(--text-muted)]">…</span>
                        ) : savedActual ? (
                          <span className="shrink-0 text-[var(--text-muted)]">已记</span>
                        ) : null}
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {detail.days.length === 0 ? (
          <p className="px-3 py-4 text-sm text-[var(--text-muted)]">这个计划没有排上任何时间。</p>
        ) : null}
      </div>

      {saveErr ? (
        <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{saveErr}</p>
      ) : null}

      {/* 校准结果：后端按整个空间的样本汇总，填过实际用时才出现 */}
      {calibration &&
      calibration.samples > 0 &&
      calibration.suggested_min_per_page !== null ? (
        <div className="mt-2 rounded-xl border border-[var(--border-muted)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--text-muted)]">
          已校准 {calibration.samples} 块（按你所有书混算）：计划{" "}
          {fmtMinutes(calibration.planned_minutes)}，实际{" "}
          {fmtMinutes(calibration.actual_minutes)}
          {calibration.bias_percent != null && calibration.bias_percent !== 0 ? (
            <b
              className={
                calibration.bias_percent > 0 ? "text-amber-700" : "text-emerald-700"
              }
            >
              {" "}
              （{calibration.bias_percent > 0 ? "估低了" : "估高了"}{" "}
              {Math.abs(calibration.bias_percent)}%）
            </b>
          ) : null}
          。按你的实际速度，每页约{" "}
          <b className="text-[var(--brand-ink)]">
            {calibration.suggested_min_per_page} 分钟
          </b>
          {calibration.current_min_per_page != null &&
          calibration.current_min_per_page !== calibration.suggested_min_per_page ? (
            <span>（当前按 {calibration.current_min_per_page} 分钟/页）</span>
          ) : null}
          ，下次排新计划时把「每页分钟」改成这个数更准。
          {calibration.samples < 3 ? (
            <span className="text-amber-700"> 样本还少，建议仅供参考。</span>
          ) : null}

          {calibration.by_book.length > 1 ? (
            <div className="mt-2 space-y-1">
              {calibration.by_book.map((b) => (
                <div key={b.plan_id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium text-[var(--brand-ink)]">{b.book_title}</span>
                  <span>
                    {b.samples} 块 · 约{" "}
                    <b className="text-[var(--brand-ink)]">
                      {b.suggested_min_per_page ?? "—"} 分钟/页
                    </b>
                  </span>
                  {b.bias_percent != null && b.bias_percent !== 0 ? (
                    <b
                      className={
                        b.bias_percent > 0 ? "text-amber-700" : "text-emerald-700"
                      }
                    >
                      {b.bias_percent > 0 ? "估低" : "估高"} {Math.abs(b.bias_percent)}%
                    </b>
                  ) : null}
                  {b.samples < 3 ? <span className="text-amber-700">样本少</span> : null}
                </div>
              ))}
            </div>
          ) : null}

          {calibration.difficulty_factors.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {calibration.difficulty_factors.map((f) => (
                <span key={f.difficulty}>
                  {DIFFICULTY_LABEL[f.difficulty] ?? `难度${f.difficulty}`}：实际{" "}
                  <b className="text-[var(--brand-ink)]">
                    {f.actual_factor != null ? `${f.actual_factor}×` : "—"}
                  </b>
                  <span className="text-[var(--text-muted)]"> / 名义 {f.nominal_factor}×</span>
                  {f.samples < 3 ? <span className="text-amber-700">（样本少）</span> : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {unplaced.length > 0 ? (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          另有 {unplaced.length} 项没排上时间（窗口不足）。
        </p>
      ) : null}
    </div>
  );
}
