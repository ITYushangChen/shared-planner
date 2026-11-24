"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AiApiError,
  conflictSuggest,
  createTodos,
  dailySummary,
  getApiBaseUrl,
  reorderTodos,
  scheduleTodos,
  type AiTodoPreview,
  type ConflictItem,
  type ConflictMove,
  type ScheduleSuggestion,
  type ScheduleSkipped,
  type ReorderResult,
} from "@/lib/ai-api";
import type { SpaceNavItem } from "@/lib/todos";
import { createClient } from "@/lib/supabase/client";
import { useSpeechToText } from "@/lib/use-speech-to-text";
import { mapAuthError } from "@/lib/error-map";

type Mode = "create" | "schedule" | "conflict" | "reorder" | "summary";

type Props = {
  spaces: SpaceNavItem[];
  defaultSpaceId?: string;
  timezone?: string;
  /** 抽屉内：去掉外层卡片边框 */
  plain?: boolean;
};

const MODE_LABEL: Record<Mode, string> = {
  create: "创建",
  schedule: "排期",
  conflict: "冲突",
  reorder: "排序",
  summary: "摘要",
};

const PRIORITY_LABEL = {
  high: "重要",
  medium: "不重要",
  low: "不重要",
} as const;
/** 排期/冲突/排序/摘要可选：全部空间 */
const ALL_SPACES = "__all__";

/** 把「排序」模式返回的裸分数换成可读的紧急性文案（紧急性 / 截止时间 / 逾期 / 已完成） */
function formatReorderMeta(t: {
  priority?: string | null;
  status?: string | null;
  due_at?: string | null;
  start_at?: string | null;
}) {
  const now = Date.now();
  const isDone = t.status === "done";
  const due = t.due_at ? Date.parse(t.due_at) : NaN;
  const hasDue = !Number.isNaN(due);
  const isOverdue = hasDue && due < now && !isDone;

  let dueLabel: string;
  if (isDone) dueLabel = "已完成";
  else if (!hasDue) dueLabel = "无截止";
  else if (due < now) {
    const overdueDays = Math.floor((now - due) / 86_400_000);
    dueLabel = overdueDays >= 1 ? `已逾期 ${overdueDays} 天` : "已逾期";
  } else {
    const days = Math.floor((due - now) / 86_400_000);
    if (days >= 1) dueLabel = `${days} 天后截止`;
    else {
      const d = new Date(due);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      dueLabel = `今天 ${hh}:${mm} 截止`;
    }
  }

  let urgency: string;
  if (isDone) urgency = "已完成";
  else if (isOverdue) urgency = "紧急";
  else if (hasDue) {
    const hours = (due - now) / 3_600_000;
    if (hours <= 24) urgency = "紧急";
    else if (hours <= 72) urgency = "较高";
    else if (hours <= 240) urgency = "普通";
    else urgency = "宽松";
  } else urgency = "普通";

  return { urgency, dueLabel, isOverdue, isDone };
}

export function AiAssistant({
  spaces,
  defaultSpaceId,
  timezone,
  plain = false,
}: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("create");
  const [spaceId, setSpaceId] = useState(
    defaultSpaceId || spaces[0]?.id || "",
  );
  const allSpaces = spaceId === ALL_SPACES;
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  /** 开始录音时已有文案，识别结果追加在其后 */
  const speechBaseRef = useRef("");
  /** 本轮已确认的最终识别片段 */
  const speechFinalRef = useRef("");

  useEffect(() => {
    if (defaultSpaceId) setSpaceId(defaultSpaceId);
  }, [defaultSpaceId]);

  const onSpeechTranscript = useCallback((chunk: string, isFinal: boolean) => {
    if (!chunk) return;
    if (isFinal) {
      speechFinalRef.current = [speechFinalRef.current, chunk]
        .filter(Boolean)
        .join(" ");
      setText(
        [speechBaseRef.current, speechFinalRef.current]
          .filter(Boolean)
          .join(speechBaseRef.current ? " " : ""),
      );
      return;
    }
    setText(
      [speechBaseRef.current, speechFinalRef.current, chunk]
        .filter(Boolean)
        .join(" "),
    );
  }, []);

  const {
    supported: speechSupported,
    listening,
    error: speechError,
    start: startSpeech,
    stop: stopSpeech,
  } = useSpeechToText(onSpeechTranscript);

  function toggleSpeech() {
    if (listening) {
      stopSpeech();
      return;
    }
    speechBaseRef.current = text.trim();
    speechFinalRef.current = "";
    startSpeech();
  }

  const [createPreview, setCreatePreview] = useState<AiTodoPreview[] | null>(
    null,
  );
  const [schedulePreview, setSchedulePreview] = useState<
    ScheduleSuggestion[] | null
  >(null);
  const [scheduleSkipped, setScheduleSkipped] = useState<ScheduleSkipped[]>([]);
  const [conflictPreview, setConflictPreview] = useState<{
    conflicts: Array<{ a: string; b: string }>;
    detail: ConflictItem[];
    suggestions: ConflictMove[];
  } | null>(null);
  const [reorderPreview, setReorderPreview] = useState<
    ReorderResult["todos"] | null
  >(null);

  /* ---- 排期范围：是否纳入未排期任务 / 纳入哪些 ---- */
  /** 是否把未排期任务一起纳入本次排期 */
  const [includeUnscheduled, setIncludeUnscheduled] = useState(true);
  const [unscheduledList, setUnscheduledList] = useState<
    Array<{
      id: string;
      title: string;
      space_id: string;
      priority: string | null;
      due_at: string | null;
    }>
    | null
  >(null);
  /** null = 全选（不传 todo_ids，交给后端按全部未排期排） */
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingUnscheduled, setLoadingUnscheduled] = useState(false);

  const apiReady = Boolean(getApiBaseUrl());
  const tz =
    timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "Asia/Shanghai";

  const loadUnscheduled = useCallback(async () => {
    setLoadingUnscheduled(true);
    try {
      const supabase = createClient();
      const scopeIds = allSpaces ? spaces.map((s) => s.id) : [spaceId];
      if (scopeIds.length === 0 || !scopeIds[0]) return;
      const { data } = await supabase
        .from("todos")
        .select("id,title,space_id,priority,due_at")
        .in("space_id", scopeIds)
        .is("start_at", null)
        .neq("status", "done")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(200);
      setUnscheduledList(
        (data ?? []) as Array<{
          id: string;
          title: string;
          space_id: string;
          priority: string | null;
          due_at: string | null;
        }>,
      );
      // 新拉到的列表默认全选
      setSelectedIds(null);
    } finally {
      setLoadingUnscheduled(false);
    }
  }, [allSpaces, spaceId, spaces]);

  // 切空间 / 切模式后列表失效
  useEffect(() => {
    setUnscheduledList(null);
    setSelectedIds(null);
    setPickerOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, mode]);

  // 展开选择器时才拉列表，避免每次打开助手都打后端
  useEffect(() => {
    if (
      mode === "schedule" &&
      pickerOpen &&
      !unscheduledList &&
      !loadingUnscheduled
    ) {
      void loadUnscheduled();
    }
  }, [mode, pickerOpen, unscheduledList, loadingUnscheduled, loadUnscheduled]);

  /** 本次请求要排的任务 id：undefined = 全部未排期 */
  const scheduleRequestIds = useMemo(() => {
    if (!includeUnscheduled) return [];
    // 没展开过列表 / 全选 → 交给后端按全部未排期处理
    if (!unscheduledList) return undefined;
    if (selectedIds === null) return undefined;
    if (selectedIds.length === 0) return [];
    if (selectedIds.length === unscheduledList.length) return undefined;
    return selectedIds;
  }, [includeUnscheduled, unscheduledList, selectedIds]);

  const unscheduledTotal = unscheduledList?.length ?? 0;
  const selectedCount = selectedIds === null ? unscheduledTotal : selectedIds.length;
  const isChecked = (id: string) =>
    selectedIds === null || selectedIds.includes(id);

  function toggleTodoId(id: string) {
    const base = selectedIds ?? unscheduledList?.map((t) => t.id) ?? [];
    setSelectedIds(
      base.includes(id) ? base.filter((x) => x !== id) : [...base, id],
    );
  }

  const placeholders = useMemo(
    () => ({
      create:
        "例：周五下班前上线 V2.3，周三下午评审，周四全天开发联调，指派给小明",
      schedule: "例：把未排期任务安排到本周工作时间内，优先重要任务",
      conflict:
        "检测所选范围的排期时间重叠（同一人被安排在同一时段）并给出挪动建议",
      reorder: "按紧急度重算排序分并更新列表",
      summary: "生成「指派给我」的今日待办摘要并写入通知",
    }),
    [],
  );

  function clearPreviews() {
    setCreatePreview(null);
    setSchedulePreview(null);
    setScheduleSkipped([]);
    setConflictPreview(null);
    setReorderPreview(null);
    setSummary(null);
  }

  function onModeChange(next: Mode) {
    if (listening) stopSpeech();
    setMode(next);
    clearPreviews();
    setMsg("");
    // 创建必须落到具体空间
    if (next === "create" && spaceId === ALL_SPACES) {
      setSpaceId(defaultSpaceId || spaces[0]?.id || "");
    }
  }

  async function runPreview(e?: FormEvent) {
    e?.preventDefault();
    if (listening) stopSpeech();
    if (mode === "create" && (!spaceId || spaceId === ALL_SPACES)) {
      setMsg("创建待办请选择具体空间");
      return;
    }
    if (!spaceId && mode !== "summary") {
      setMsg("请选择空间");
      return;
    }
    if (mode === "create" && !text.trim()) {
      setMsg("请先输入一句话");
      return;
    }
    // 排期：关掉「纳入未排期」又没勾任何任务 → 没有可排对象
    if (mode === "schedule" && scheduleRequestIds && scheduleRequestIds.length === 0) {
      setMsg(
        includeUnscheduled
          ? "请至少勾选一条要排期的任务"
          : "已关闭「纳入未排期任务」，请先勾选要排期的任务",
      );
      return;
    }

    setLoading(true);
    setMsg("AI 思考中…");
    clearPreviews();

    try {
      if (mode === "create") {
        const res = await createTodos({
          space_id: spaceId,
          text: text.trim(),
          confirm: false,
          timezone: tz,
        });
        if ("todos" in res && res.preview) {
          setCreatePreview(res.todos);
          setSummary(res.summary);
          setMsg(`预览 ${res.todos.length} 条，确认后写入`);
        }
      } else if (mode === "schedule") {
        const res = await scheduleTodos({
          space_id: allSpaces ? undefined : spaceId,
          all_spaces: allSpaces,
          text: text.trim() || undefined,
          todo_ids: scheduleRequestIds ?? undefined,
          include_unscheduled: includeUnscheduled,
          confirm: false,
          timezone: tz,
        });
        if (!("suggestions" in res) || res.suggestions.length === 0) {
          setSchedulePreview(null);
          setScheduleSkipped("skipped" in res ? res.skipped ?? [] : []);
          setMsg(res.message || "没有需要排期的待办");
        } else {
          setSchedulePreview(res.suggestions);
          setScheduleSkipped("skipped" in res ? res.skipped ?? [] : []);
          setMsg(
            res.message ||
              `预览 ${res.suggestions.length} 条排期建议${
                allSpaces ? "（全部空间）" : ""
              }`,
          );
        }
      } else if (mode === "conflict") {
        const res = await conflictSuggest({
          space_id: allSpaces ? undefined : spaceId,
          all_spaces: allSpaces,
          confirm: false,
        });
        const detail =
          "conflicts_detail" in res && res.conflicts_detail
            ? res.conflicts_detail
            : [];
        const moves = "suggestions" in res ? res.suggestions ?? [] : [];
        if (moves.length === 0) {
          // 有冲突但没有建议时，也要把冲突任务显示出来，不能只留一句提示
          setConflictPreview(
            detail.length > 0 ? { conflicts: [], detail, suggestions: [] } : null,
          );
          setMsg(res.message || "未检测到冲突");
        } else {
          setConflictPreview({
            conflicts: "conflicts" in res ? res.conflicts : [],
            detail,
            suggestions: moves,
          });
          setMsg(
            res.message ||
              `发现冲突，${moves.length} 条调整建议${
                allSpaces ? "（全部空间）" : ""
              }`,
          );
        }
      } else if (mode === "reorder") {
        const res = await reorderTodos({
          space_id: allSpaces ? undefined : spaceId,
          all_spaces: allSpaces,
          persist: false,
        });
        setReorderPreview(res.todos.slice(0, 20));
        setMsg(
          `已计算 ${res.todos.length} 条排序（未写入，点确认应用）${allSpaces ? " · 全部空间" : ""}`,
        );
      } else if (mode === "summary") {
        const res = await dailySummary({
          space_id: allSpaces ? undefined : spaceId || undefined,
          timezone: tz,
        });
        setSummary(res.summary);
        setMsg(`${res.date} 摘要已生成（今日 ${res.today_count} 项）`);
      }
    } catch (err) {
      setMsg(err instanceof AiApiError ? mapAuthError(err.message) : "请求失败");
    } finally {
      setLoading(false);
    }
  }

  async function runConfirm() {
    if (mode === "create" && (!spaceId || spaceId === ALL_SPACES)) {
      setMsg("创建待办请选择具体空间");
      return;
    }
    if (!spaceId && mode !== "summary") {
      setMsg("请选择空间");
      return;
    }
    setLoading(true);
    setMsg("写入中…");

    try {
      if (mode === "create") {
        if (!text.trim()) {
          setMsg("缺少原始输入");
          setLoading(false);
          return;
        }
        const res = await createTodos({
          space_id: spaceId,
          text: text.trim(),
          confirm: true,
          timezone: tz,
        });
        if ("todo_ids" in res) {
          setMsg(`已创建 ${res.todo_ids.length} 条待办`);
          clearPreviews();
          setText("");
          router.refresh();
        }
      } else if (mode === "schedule") {
        const res = await scheduleTodos({
          space_id: allSpaces ? undefined : spaceId,
          all_spaces: allSpaces,
          text: text.trim() || undefined,
          todo_ids: scheduleRequestIds ?? undefined,
          include_unscheduled: includeUnscheduled,
          confirm: true,
          timezone: tz,
        });
        if ("applied" in res) {
          setMsg(
            res.message || `已应用 ${res.applied.length} 条排期`,
          );
          clearPreviews();
          router.refresh();
        }
      } else if (mode === "conflict") {
        const res = await conflictSuggest({
          space_id: allSpaces ? undefined : spaceId,
          all_spaces: allSpaces,
          confirm: true,
        });
        if ("applied" in res) {
          setMsg(res.message || `已调整 ${res.applied.length} 条`);
          clearPreviews();
          router.refresh();
        }
      } else if (mode === "reorder") {
        const res = await reorderTodos({
          space_id: allSpaces ? undefined : spaceId,
          all_spaces: allSpaces,
          persist: true,
        });
        setMsg(`已更新 ${res.todos.length} 条排序分`);
        clearPreviews();
        router.refresh();
      }
    } catch (err) {
      setMsg(err instanceof AiApiError ? mapAuthError(err.message) : "确认失败");
    } finally {
      setLoading(false);
    }
  }

  const canConfirm =
    (mode === "create" && (createPreview?.length ?? 0) > 0) ||
    (mode === "schedule" && (schedulePreview?.length ?? 0) > 0) ||
    (mode === "conflict" && (conflictPreview?.suggestions.length ?? 0) > 0) ||
    (mode === "reorder" && (reorderPreview?.length ?? 0) > 0);

  const needsText = mode === "create" || mode === "schedule";
  const primaryLabel =
    mode === "summary"
      ? "生成摘要"
      : mode === "reorder"
        ? "预览排序"
        : mode === "conflict"
          ? "检测冲突"
          : "预览";

  if (spaces.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 text-sm text-zinc-500">
        请先创建或加入空间后再使用 AI
      </div>
    );
  }

  return (
    <section
      className={
        plain
          ? "bg-white"
          : "rounded-xl border border-zinc-200 bg-white p-4"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {plain ? null : (
            <h2 className="text-sm font-medium text-zinc-800">AI 助手</h2>
          )}
          {/* 此前是写死的「· 请先选择目标空间」，选了空间也照提示，纯误导 */}
          <p className={plain ? "text-xs text-zinc-400" : "mt-0.5 text-xs text-zinc-400"}>
            先预览，确认后再写入（{tz}）·{" "}
            {spaceId && spaceId !== ALL_SPACES
              ? `目标：${spaces.find((s) => s.id === spaceId)?.name ?? "当前空间"}`
              : spaceId === ALL_SPACES
                ? "目标：全部空间（跨空间）"
                : "请先选择目标空间"}
          </p>
        </div>
        {!apiReady ? (
          <p className="text-xs text-amber-700">
            未配置 NEXT_PUBLIC_API_URL
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            className={[
              "rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors duration-200",
              mode === m
                ? "bg-zinc-900 text-white"
                : "border border-[#2f5f8f]/55 bg-white text-[#2f5f8f] hover:bg-[#e8f0f7]",
            ].join(" ")}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <form onSubmit={runPreview} className="mt-3 flex flex-col gap-2">
        <label className="text-xs text-zinc-500">
          目标空间
          <select
            className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
          >
            {mode !== "create" ? (
              <option value={ALL_SPACES}>全部空间（跨空间）</option>
            ) : null}
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.visibility === "public" ? " · 公共" : ""}
              </option>
            ))}
          </select>
        </label>
        {mode !== "create" && allSpaces ? (
          <p className="text-[11px] text-zinc-400">
            将处理你加入的所有空间中的任务（创建功能仍需指定单一空间）
          </p>
        ) : null}

        {needsText ? (
          <div className="flex flex-col gap-2">
            <textarea
              className="min-h-[72px] rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
              placeholder={placeholders[mode]}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={loading || !speechSupported}
                onClick={toggleSpeech}
                className={[
                  "min-h-11 min-w-[7.5rem] touch-manipulation rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-200 disabled:opacity-50",
                  listening
                    ? "bg-red-600 text-white hover:bg-red-500"
                    : "border border-[#2f5f8f]/55 bg-white text-[#2f5f8f] hover:bg-[#e8f0f7]",
                ].join(" ")}
                aria-pressed={listening}
              >
                {listening ? "停止聆听" : "语音输入"}
              </button>
              {listening ? (
                <span className="text-xs text-red-600">正在聆听，说完再点停止</span>
              ) : null}
              {!speechSupported ? (
                <span className="text-xs text-zinc-400">
                  当前浏览器不支持语音（建议 Chrome）
                </span>
              ) : null}
            </div>
            {speechError ? (
              <p className="text-xs text-amber-700">{speechError}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">{placeholders[mode]}</p>
        )}

        {mode === "schedule" ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 px-3 py-2">
            <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-700">
              <input
                type="checkbox"
                className="mt-0.5 accent-[#2f5f8f]"
                checked={includeUnscheduled}
                onChange={(e) => {
                  setIncludeUnscheduled(e.target.checked);
                  // 关掉时清空已选，避免误排
                  setSelectedIds(e.target.checked ? null : []);
                }}
              />
              <span>
                纳入未排期任务
                <span className="ml-1 text-zinc-400">
                  （不勾选就只排你在下面挑的任务）
                </span>
              </span>
            </label>

            <div className="mt-1.5 pl-6">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="text-xs text-[#2f5f8f] underline underline-offset-2"
              >
                {pickerOpen ? "收起任务列表" : "选择要排期的任务"}
                <span className="ml-1 text-zinc-400 no-underline">
                  {loadingUnscheduled
                    ? "加载中…"
                    : unscheduledList
                      ? `已选 ${selectedCount}/${unscheduledTotal}`
                      : "默认全部未排期"}
                </span>
              </button>

              {pickerOpen ? (
                <div className="mt-1.5">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
                    <button
                      type="button"
                      className="underline"
                      onClick={() =>
                        setSelectedIds(unscheduledList?.map((t) => t.id) ?? null)
                      }
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setSelectedIds([])}
                    >
                      清空
                    </button>
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void loadUnscheduled()}
                    >
                      刷新
                    </button>
                  </div>
                  <ul className="max-h-48 overflow-auto rounded-lg border border-zinc-200 bg-white">
                    {unscheduledList && unscheduledList.length > 0 ? (
                      unscheduledList.map((t) => (
                        <li key={t.id}>
                          <label className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-xs hover:bg-zinc-50">
                            <input
                              type="checkbox"
                              className="mt-0.5 accent-[#2f5f8f]"
                              checked={isChecked(t.id)}
                              onChange={() => toggleTodoId(t.id)}
                            />
                            <span className="flex-1 text-zinc-700">{t.title}</span>
                            {t.due_at ? (
                              <span className="shrink-0 text-[11px] text-zinc-400">
                                截止 {new Date(t.due_at).toLocaleDateString()}
                              </span>
                            ) : null}
                          </label>
                        </li>
                      ))
                    ) : (
                      <li className="px-2 py-2 text-xs text-zinc-400">
                        {loadingUnscheduled ? "加载中…" : "没有未排期任务"}
                      </li>
                    )}
                  </ul>
                </div>
              ) : null}
            </div>

            <p className="mt-1.5 pl-6 text-[11px] text-zinc-400">
              排期会自动避开你和被指派人已有安排的时段，撞车会顺延到最近空闲时间。
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={loading || !apiReady}
            className="rounded-xl bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "处理中…" : primaryLabel}
          </button>
          {canConfirm ? (
            <button
              type="button"
              disabled={loading}
              onClick={runConfirm}
              className="rounded-xl border border-[var(--success)] bg-[var(--success-soft)] px-3 py-2 text-sm font-medium text-[var(--success)] transition-colors duration-200 disabled:opacity-50"
            >
              确认写入
            </button>
          ) : null}
          {(createPreview ||
            schedulePreview ||
            conflictPreview ||
            reorderPreview ||
            summary) &&
          mode !== "summary" ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                clearPreviews();
                setMsg("");
              }}
              className="rounded-xl border border-[#2f5f8f]/55 px-3 py-2 text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7] disabled:opacity-50"
            >
              丢弃预览
            </button>
          ) : null}
        </div>
      </form>

      {msg ? <p className="mt-2 text-xs text-zinc-500">{msg}</p> : null}

      {summary && mode === "summary" ? (
        <div className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700 whitespace-pre-wrap">
          {summary}
        </div>
      ) : null}

      {summary && mode === "create" ? (
        <p className="mt-2 text-sm text-zinc-600">{summary}</p>
      ) : null}

      {createPreview?.length ? (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-100">
          {createPreview.map((t, i) => (
            <li key={`${t.title}-${i}`} className="px-3 py-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="font-medium text-zinc-900">{t.title}</span>
                <span className="shrink-0 text-xs text-zinc-400">
                  {PRIORITY_LABEL[t.priority] || t.priority}
                  {t.is_all_day ? " · 全天" : ""}
                </span>
              </div>
              <p className="text-xs text-zinc-500">
                {t.start_at
                  ? `${new Date(t.start_at).toLocaleString()}${
                      t.end_at
                        ? ` – ${new Date(t.end_at).toLocaleString()}`
                        : ""
                    }`
                  : "未排期"}
                {t.assignee_names?.length
                  ? ` · ${t.assignee_names.join("、")}`
                  : ""}
              </p>
              {t.description ? (
                <p className="mt-0.5 text-xs text-zinc-400">{t.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {schedulePreview?.length ? (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-100">
          {schedulePreview.map((s) => (
            <li key={s.todo_id} className="px-3 py-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-zinc-900">{s.title}</p>
              </div>
              <p className="text-xs text-zinc-500">
                {new Date(s.start_at).toLocaleString()} –{" "}
                {new Date(s.end_at).toLocaleString()}
              </p>
              {s.reason ? (
                <p className="text-xs text-zinc-400">{s.reason}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {scheduleSkipped.length ? (
        <ul className="mt-2 space-y-1 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
          {scheduleSkipped.map((s) => (
            <li key={s.todo_id} className="text-xs text-amber-800">
              未排入「{s.title}」：{s.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {conflictPreview?.detail.length ? (
        <div className="mt-3 rounded-lg border border-red-100 bg-red-50/50 px-3 py-2">
          <p className="text-xs font-medium text-red-700">
            以下任务时间重叠（同一指派人 / 无指派时按创建人）
          </p>
          <ul className="mt-1 space-y-0.5">
            {conflictPreview.detail.map((c) => (
              <li key={c.id} className="text-xs text-red-700/90">
                · {c.title}
                <span className="ml-1 text-red-500/80">
                  {c.start_at ? new Date(c.start_at).toLocaleString() : ""}
                  {c.end_at
                    ? ` – ${new Date(c.end_at).toLocaleTimeString()}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {conflictPreview?.suggestions.length ? (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-red-100">
          {conflictPreview.suggestions.map((s) => (
            <li key={s.todo_id} className="px-3 py-2 text-sm">
              <p className="font-medium text-zinc-900">{s.title}</p>
              <p className="text-xs text-zinc-500">
                {new Date(s.from_start_at).toLocaleString()} →{" "}
                {new Date(s.to_start_at).toLocaleString()}
              </p>
              <p className="text-xs text-zinc-400">{s.reason}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {reorderPreview?.length ? (
        <ol className="mt-3 list-decimal space-y-1 rounded-lg border border-zinc-100 px-5 py-2 text-sm">
          {reorderPreview.map((t) => {
            const m = formatReorderMeta(t);
            return (
              <li key={t.id} className="text-zinc-800">
                {t.title}
                <span
                  className={`ml-2 text-xs ${
                    m.isOverdue ? "text-red-500 font-medium" : "text-zinc-400"
                  }`}
                >
                  {m.isDone
                    ? "已完成"
                    : `${PRIORITY_LABEL[t.priority as keyof typeof PRIORITY_LABEL] ?? ""}${
                        PRIORITY_LABEL[t.priority as keyof typeof PRIORITY_LABEL]
                          ? " · "
                          : ""
                      }${m.urgency} · ${m.dueLabel}`}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
