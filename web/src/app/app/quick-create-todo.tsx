"use client";

import { FormEvent, useState } from "react";
import { newId } from "@/lib/id";
import { createClient } from "@/lib/supabase/client";
import { notifyTodoAssignment } from "@/lib/notify";
import {
  emitTodoDeleted,
  emitTodoUpserted,
} from "@/lib/todo-schedule-events";
import { suppressTodosRealtimeRefresh } from "@/lib/todos-realtime-gate";
import {
  allDayRangeToIso,
  RECUR_OPTIONS,
  type SpaceMemberOption,
  type SpaceNavItem,
  type TodoRow,
} from "@/lib/todos";
import { resolveTodoColor } from "@/lib/ui-prefs";
import { useUiPrefsOptional } from "./ui-prefs-provider";
import { RecurrenceField } from "./recurrence-field";
import { useIsMobile } from "./use-is-mobile";

/** 总览：落到「创建到」下拉里的第一项可见空间（bootstrap 默认空间不进列表） */
const OVERVIEW_VALUE = "__overview__";

/** 日期胶囊：预填到今天/明天/下周一；自定义走原生 date */
const QUICK_DATES = [
  { key: "today", label: "今天" },
  { key: "tomorrow", label: "明天" },
  { key: "nextMon", label: "下周一" },
] as const;
type ChipKey = (typeof QUICK_DATES)[number]["key"] | "custom";
const DURATION_PRESETS = [15, 30, 60];
const COLOR_SWATCHES = ["", "#378ADD", "#1D9E75", "#BA7517", "#D85A30"];

function localDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function quickDate(key: Exclude<ChipKey, "custom">): string {
  const d = new Date();
  if (key === "tomorrow") d.setDate(d.getDate() + 1);
  if (key === "nextMon") {
    const day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? 1 : 8 - day));
  }
  return localDateStr(d);
}

function chipKeyOf(dateStr: string): ChipKey {
  for (const q of QUICK_DATES) {
    if (quickDate(q.key) === dateStr) return q.key;
  }
  return "custom";
}

type Props = {
  spaces: SpaceNavItem[];
  defaultSpaceId?: string;
  members?: SpaceMemberOption[];
  membersBySpace?: Record<string, SpaceMemberOption[]>;
  /** 所有者/管理员可指派他人；成员只能给自己 */
  canAssign?: boolean;
  /** 弹窗内使用：去掉外框与标题 */
  bare?: boolean;
  /** 总览页：可选「创建到总览」→ 个人默认空间 */
  allowOverview?: boolean;
  /** 日历点选预填：datetime-local */
  initialStartLocal?: string;
  initialEndLocal?: string;
  initialIsAllDay?: boolean;
  initialStartDate?: string;
  initialPriority?: "high" | "low";
  onCreated?: () => void;
};

export function QuickCreateTodo({
  spaces,
  defaultSpaceId,
  members = [],
  membersBySpace,
  canAssign = false,
  bare = false,
  allowOverview = false,
  initialStartLocal = "",
  initialEndLocal = "",
  initialIsAllDay = false,
  initialStartDate = "",
  initialPriority = "low",
  onCreated,
}: Props) {
  const supabase = createClient();
  const isMobile = useIsMobile();
  const defaultSpace = spaces[0]?.id || "";
  /** 总览选项实际落到的空间名（写死「个人默认空间」会误导：真实落点是列表第一项） */
  const defaultSpaceName = spaces.find((s) => s.id === defaultSpace)?.name ?? "";
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState("");
  const [spaceId, setSpaceId] = useState(
    allowOverview && !defaultSpaceId
      ? OVERVIEW_VALUE
      : defaultSpaceId || defaultSpace,
  );
  const resolvedSpaceId =
    spaceId === OVERVIEW_VALUE ? defaultSpace : spaceId;
  const activeMembers = membersBySpace?.[resolvedSpaceId] ?? members;
  const spaceRole = spaces.find((s) => s.id === resolvedSpaceId)?.role;
  const allowAssign =
    canAssign || spaceRole === "owner" || spaceRole === "admin";
  const [isAllDay, setIsAllDay] = useState(initialIsAllDay);
  const [startLocal, setStartLocal] = useState(initialStartLocal);
  const [endLocal, setEndLocal] = useState(initialEndLocal);
  const [startDate, setStartDate] = useState(
    initialStartDate ||
      (initialIsAllDay && initialStartLocal
        ? initialStartLocal.slice(0, 10)
        : ""),
  );
  const [durationMin, setDurationMin] = useState(60);
  const [priority, setPriority] = useState<"high" | "medium" | "low">(
    initialPriority,
  );
  const [color, setColor] = useState("");
  const [rrule, setRrule] = useState("");
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [showTime, setShowTime] = useState(
    Boolean(initialStartLocal || initialStartDate),
  );
  const [showMore, setShowMore] = useState(false);
  const [dateChip, setDateChip] = useState<ChipKey>(() => {
    const d = initialStartDate || initialStartLocal.slice(0, 10);
    return d ? chipKeyOf(d) : "custom";
  });
  const uiPrefs = useUiPrefsOptional()?.globalPrefs;
  const previewColor = resolveTodoColor(
    color.trim() || null,
    priority,
    uiPrefs,
  );

  const currentDate =
    startLocal.slice(0, 10) || startDate || quickDate("today");
  const currentTime = startLocal.slice(11, 16) || "09:00";
  const activeChip = startLocal || startDate ? chipKeyOf(currentDate) : "";

  const scheduleSummary = (() => {
    if (isAllDay) {
      return startDate
        ? `将安排到：${startDate} 全天`
        : "不填时间也可以先建，之后在日历上排期";
    }
    if (!startLocal) {
      return "不填时间也可以先建，之后在日历上排期";
    }
    const label =
      QUICK_DATES.find((q) => quickDate(q.key) === currentDate)?.label ??
      currentDate;
    return `将安排到：${label} ${currentTime} · ${durationMin} 分钟`;
  })();

  function toggleAssignee(id: string) {
    setAssigneeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function applyDuration(startValue: string, minutes: number) {
    if (!startValue || minutes <= 0) return;
    const start = new Date(startValue);
    const end = new Date(start.getTime() + minutes * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    setEndLocal(
      `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`,
    );
  }

  function pickDate(key: ChipKey) {
    const d =
      key === "custom"
        ? startDate || startLocal.slice(0, 10) || quickDate("today")
        : quickDate(key);
    setDateChip(key);
    if (isAllDay) {
      setStartDate(d);
    } else {
      const v = `${d}T${currentTime}`;
      setStartLocal(v);
      applyDuration(v, durationMin);
    }
    setMsg("");
  }

  function changeCustomDate(d: string) {
    setStartDate(d);
    if (!isAllDay) {
      const v = `${d}T${currentTime}`;
      setStartLocal(v);
      applyDuration(v, durationMin);
    }
    setMsg("");
  }

  function changeTime(t: string) {
    const v = `${currentDate}T${t}`;
    setStartLocal(v);
    applyDuration(v, durationMin);
    setMsg("");
  }

  function changeDuration(n: number) {
    const safe = Math.min(24 * 60, Math.max(1, Math.floor(n) || 1));
    setDurationMin(safe);
    if (startLocal) applyDuration(startLocal, safe);
  }

  function toggleAllDay(next: boolean) {
    if (next) {
      setStartDate(startLocal.slice(0, 10) || currentDate);
    } else {
      const d = startDate || currentDate;
      const v = `${d}T${currentTime}`;
      setStartLocal(v);
      applyDuration(v, durationMin);
    }
    setIsAllDay(next);
    setMsg("");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // 桌面端保持改造前的校验文案与位置；手机端用就地红字 + 更细的时间校验
    if (!title.trim() || !resolvedSpaceId) {
      if (isMobile && !title.trim()) {
        setTitleError("给待办起个名字");
      } else {
        setMsg(isMobile ? "请选择要创建到的空间" : "请填写标题并选择空间");
      }
      return;
    }
    setTitleError("");
    if (
      isMobile &&
      !isAllDay &&
      startLocal &&
      endLocal &&
      new Date(endLocal).getTime() <= new Date(startLocal).getTime()
    ) {
      setMsg("结束时间要晚于开始时间");
      return;
    }

    setLoading(true);
    setMsg("创建中…");

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setLoading(false);
      setMsg("请先登录");
      return;
    }

    let start_at: string | null = null;
    let end_at: string | null = null;
    let duration_minutes: number | null = Math.max(1, durationMin || 60);
    if (isAllDay && startDate) {
      const range = allDayRangeToIso(startDate);
      start_at = range.start_at;
      end_at = range.end_at;
      duration_minutes = null;
    } else {
      start_at = startLocal ? new Date(startLocal).toISOString() : null;
      end_at = endLocal ? new Date(endLocal).toISOString() : null;
      if (start_at && !end_at) {
        end_at = new Date(
          new Date(start_at).getTime() + duration_minutes * 60 * 1000,
        ).toISOString();
      } else if (start_at && end_at) {
        const ms =
          new Date(end_at).getTime() - new Date(start_at).getTime();
        if (Number.isFinite(ms) && ms > 0) {
          duration_minutes = Math.max(1, Math.round(ms / 60000));
        }
      }
      if (!start_at) {
        end_at = null;
      }
    }

    const hasSchedule = Boolean(start_at);
    const assign =
      allowAssign && assigneeIds.length > 0
        ? assigneeIds
        : hasSchedule
          ? [user.id]
          : [];
    const spaceMeta = spaces.find((s) => s.id === resolvedSpaceId);
    const todoId = newId();
    const optimistic: TodoRow = {
      id: todoId,
      title: title.trim(),
      description: null,
      priority,
      status: "todo",
      start_at,
      end_at,
      is_all_day: isAllDay,
      due_at: null,
      duration_minutes,
      space_id: resolvedSpaceId,
      creator_id: user.id,
      color: color.trim() || null,
      rrule: rrule.trim() || null,
      spaces: spaceMeta
        ? { id: spaceMeta.id, name: spaceMeta.name, kind: spaceMeta.kind }
        : null,
      todo_assignees: assign.map((user_id) => ({ user_id })),
    };

    // 立刻出现在日历/未排期，再写库
    suppressTodosRealtimeRefresh(8000);
    emitTodoUpserted(optimistic);
    setTitle("");
    setStartLocal("");
    setEndLocal("");
    setStartDate("");
    setIsAllDay(false);
    setDurationMin(60);
    setAssigneeIds([]);
    setColor("");
    setRrule("");
    setShowTime(false);
    setShowMore(false);
    setDateChip("custom");
    setLoading(false);
    setMsg("");
    onCreated?.();

    const { error } = await supabase.from("todos").insert({
      id: todoId,
      space_id: resolvedSpaceId,
      creator_id: user.id,
      title: optimistic.title,
      priority,
      color: optimistic.color,
      status: "todo",
      start_at,
      end_at,
      is_all_day: isAllDay,
      duration_minutes,
      rrule: rrule.trim() || null,
      source: "manual",
    });

    if (error) {
      emitTodoDeleted(todoId);
      setMsg(error.message || "创建失败");
      return;
    }

    if (assign.length > 0) {
      const { error: aerr } = await supabase.from("todo_assignees").insert(
        assign.map((user_id) => ({ todo_id: todoId, user_id })),
      );
      if (aerr) {
        setMsg(aerr.message);
        return;
      }
    }
    if (assign.length > 0 || hasSchedule) {
      void notifyTodoAssignment(todoId);
    }
  }

  if (spaces.length === 0) {
    return (
      <p className="text-sm text-zinc-500">请先创建空间后再添加待办。</p>
    );
  }

  // 桌面端：改造前的原始表单，字段一次性全铺，样式/文案/控件 100% 不动
  if (!isMobile) {
    return (
      <form
        onSubmit={onSubmit}
        className={
          bare
            ? "flex flex-col gap-2"
            : "flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3"
        }
      >
        {bare ? null : (
          <h3 className="text-sm font-medium text-zinc-800">快速创建待办</h3>
        )}
        <input
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
          placeholder="待办标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <label className="text-xs text-zinc-500">
          创建到
          <select
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none"
            value={spaceId}
            onChange={(e) => {
              setSpaceId(e.target.value);
              setAssigneeIds([]);
            }}
          >
            {allowOverview ? (
              <option value={OVERVIEW_VALUE}>
                总览工作区
                {defaultSpaceName ? `（${defaultSpaceName}）` : "（暂无空间）"}
              </option>
            ) : null}
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-600">
          <input
            type="checkbox"
            checked={isAllDay}
            onChange={(e) => setIsAllDay(e.target.checked)}
          />
          全天事件
        </label>
        {isAllDay ? (
          <label className="text-xs text-zinc-500">
            日期
            <input
              type="date"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-500">
                开始（可选）
                <input
                  type="datetime-local"
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  value={startLocal}
                  onChange={(e) => {
                    setStartLocal(e.target.value);
                    applyDuration(e.target.value, durationMin);
                  }}
                />
              </label>
              <label className="text-xs text-zinc-500">
                结束（可选）
                <input
                  type="datetime-local"
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  value={endLocal}
                  onChange={(e) => setEndLocal(e.target.value)}
                />
              </label>
            </div>
            <label className="text-xs text-zinc-500">
              任务时长（分钟，精确）
              <input
                type="number"
                min={1}
                max={24 * 60}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                value={durationMin}
                onChange={(e) => {
                  const n = Number(e.target.value) || 1;
                  setDurationMin(n);
                  if (startLocal) applyDuration(startLocal, n);
                }}
              />
            </label>
          </>
        )}
        <label className="text-xs text-zinc-500">
          重要性
          <select
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={priority}
            onChange={(e) =>
              setPriority(e.target.value as "high" | "medium" | "low")
            }
            style={{
              borderLeftWidth: 4,
              borderLeftColor: previewColor,
            }}
          >
            <option value="high">重要</option>
            <option value="medium">中等</option>
            <option value="low">不重要</option>
          </select>
        </label>
        <label className="text-xs text-zinc-500">
          重复
          <select
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={rrule}
            onChange={(e) => setRrule(e.target.value)}
          >
            {RECUR_OPTIONS.map((o) => (
              <option key={o.value || "none"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-zinc-500">
            卡片/日历颜色（可选）
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="留空用优先级默认色"
            />
          </label>
          <input
            type="color"
            className="h-10 w-12 cursor-pointer rounded border border-zinc-200"
            value={
              /^#[0-9a-fA-F]{6}$/.test(previewColor) ? previewColor : "#4a6fa5"
            }
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        {allowAssign && activeMembers.length > 0 ? (
          <fieldset className="rounded-lg border border-zinc-200 bg-white p-2">
            <legend className="px-1 text-xs text-zinc-500">指派人（可多选，可不选）</legend>
            <div className="flex max-h-24 flex-col gap-1 overflow-y-auto">
              {activeMembers.map((m) => (
                <label
                  key={m.user_id}
                  className="flex items-center gap-2 text-xs text-zinc-700"
                >
                  <input
                    type="checkbox"
                    checked={assigneeIds.includes(m.user_id)}
                    onChange={() => toggleAssignee(m.user_id)}
                  />
                  {m.display_name}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-zinc-400">
              未排期可不选指派人；已填时间且未选时默认指派自己
            </p>
          </fieldset>
        ) : (
          <p className="text-[11px] text-zinc-400">
            普通成员不能指定指派人；未排期可不指派，填时间后将指派给你自己
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="rounded-xl bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "创建中…" : "添加待办"}
        </button>
        {msg ? <p className="text-xs text-zinc-500">{msg}</p> : null}
      </form>
    );
  }

  // 手机端（≤767px）：三层收敛新设计
  return (
    <form
      onSubmit={onSubmit}
      className={
        bare
          ? "flex flex-col gap-3"
          : "flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3"
      }
    >
      {bare ? null : (
        <h3 className="text-sm font-medium text-zinc-800">快速创建待办</h3>
      )}

      {/* 第 1 层：标题（唯一必填） */}
      <div>
        <label className="flex items-center justify-between text-xs text-zinc-600">
          <span>
            要做什么 <span className="text-red-600">*</span>
          </span>
        </label>
        <input
          className={`mt-1 w-full rounded-lg border bg-white px-3 py-2.5 text-sm outline-none ${
            titleError ? "border-red-400" : "border-zinc-200 focus:border-zinc-400"
          }`}
          placeholder="例如：交物业费"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (e.target.value.trim()) setTitleError("");
          }}
          aria-invalid={Boolean(titleError)}
        />
        {titleError ? (
          <p className="mt-1 text-[11px] text-red-600">{titleError}</p>
        ) : null}
      </div>

      {/* 第 1 层：什么时候（折叠摘要 + 展开面板） */}
      <div className="rounded-lg border border-zinc-200 bg-white">
        <button
          type="button"
          onClick={() => setShowTime((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2.5 text-left"
          aria-expanded={showTime}
        >
          <span className="text-xs text-zinc-600">
            什么时候 <span className="text-[10px] text-zinc-400">可选</span>
          </span>
          <span className="text-[11px] text-zinc-500">
            {startLocal || startDate ? "已设置" : "未设置"}
            <span className="ml-1 text-zinc-400">{showTime ? "▴" : "▾"}</span>
          </span>
        </button>
        {showTime ? (
          <div className="flex flex-col gap-2 border-t border-zinc-100 px-3 py-3">
            <div className="flex gap-2">
              {[
                { v: false, label: "定时" },
                { v: true, label: "全天" },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => toggleAllDay(o.v)}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${
                    isAllDay === o.v
                      ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-ink)]"
                      : "border-zinc-200 bg-white text-zinc-600"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {QUICK_DATES.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  onClick={() => pickDate(q.key)}
                  className={`rounded-lg border px-3 py-1.5 text-xs ${
                    activeChip === q.key
                      ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-ink)]"
                      : "border-zinc-200 bg-white text-zinc-600"
                  }`}
                >
                  {q.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => pickDate("custom")}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  activeChip === "custom"
                    ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-ink)]"
                    : "border-zinc-200 bg-white text-zinc-600"
                }`}
              >
                自定义
              </button>
            </div>
            {dateChip === "custom" ? (
              <label className="text-[11px] text-zinc-500">
                日期
                <input
                  type="date"
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                  value={isAllDay ? startDate : startLocal.slice(0, 10)}
                  onChange={(e) => changeCustomDate(e.target.value)}
                />
              </label>
            ) : null}
            {!isAllDay ? (
              <>
                <div className="flex gap-2">
                  <label className="text-[11px] text-zinc-500">
                    时间点
                    <input
                      type="time"
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                      value={currentTime}
                      onChange={(e) => changeTime(e.target.value)}
                    />
                  </label>
                </div>
                <div>
                  <p className="text-[11px] text-zinc-500">时长</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {DURATION_PRESETS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => changeDuration(n)}
                        className={`rounded-lg border px-3 py-1.5 text-xs ${
                          durationMin === n
                            ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-ink)]"
                            : "border-zinc-200 bg-white text-zinc-600"
                        }`}
                      >
                        {n} 分钟
                      </button>
                    ))}
                    <input
                      type="number"
                      min={1}
                      max={24 * 60}
                      inputMode="numeric"
                      aria-label="自定义时长（分钟）"
                      className="w-20 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                      value={durationMin}
                      onChange={(e) => changeDuration(Number(e.target.value))}
                    />
                  </div>
                </div>
              </>
            ) : null}
            <p className="rounded-lg bg-[var(--brand-soft)] px-2 py-1.5 text-[11px] text-[var(--brand-ink)]">
              {scheduleSummary}
            </p>
          </div>
        ) : null}
      </div>

      {/* 第 1 层：创建到 */}
      <label className="text-xs text-zinc-600">
        创建到
        <select
          className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none"
          value={spaceId}
          onChange={(e) => {
            setSpaceId(e.target.value);
            setAssigneeIds([]);
          }}
        >
          {allowOverview ? (
            <option value={OVERVIEW_VALUE}>
              总览工作区
              {defaultSpaceName ? `（${defaultSpaceName}）` : "（暂无空间）"}
            </option>
          ) : null}
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      {/* 第 2 层：更多设置 */}
      <div className="border-t border-zinc-100 pt-2">
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="flex w-full items-center justify-between py-1 text-left text-xs text-zinc-600"
          aria-expanded={showMore}
        >
          <span>
            更多设置
            <span className="ml-2 text-[10px] text-zinc-400">
              重要性 · 重复 · 颜色 · 指派人
            </span>
          </span>
          <span className="text-zinc-400">{showMore ? "收起 ▴" : "展开 ▾"}</span>
        </button>
        {showMore ? (
          <div className="mt-2 flex flex-col gap-3 rounded-lg bg-zinc-50 p-3">
            <div>
              <p className="text-xs text-zinc-600">重要性</p>
              <div className="mt-1 flex gap-2">
                {[
                  { v: "low", label: "不重要" },
                  { v: "medium", label: "中等" },
                  { v: "high", label: "重要" },
                ].map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() =>
                      setPriority(o.v as "low" | "medium" | "high")
                    }
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${
                      priority === o.v
                        ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-ink)]"
                        : "border-zinc-200 bg-white text-zinc-600"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <RecurrenceField value={rrule} onChange={setRrule} />

            <div>
              <p className="text-xs text-zinc-600">
                颜色 <span className="text-[10px] text-zinc-400">可选</span>
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {COLOR_SWATCHES.map((c) => (
                  <button
                    key={c || "default"}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-label={c ? `颜色 ${c}` : "默认颜色"}
                    className={`h-7 w-7 rounded-full border-2 ${
                      color.trim() === c
                        ? "border-zinc-900"
                        : "border-zinc-200"
                    }`}
                    style={{
                      backgroundColor: c || resolveTodoColor(null, priority, uiPrefs),
                    }}
                  />
                ))}
                <input
                  type="color"
                  aria-label="自定义颜色"
                  className="h-8 w-10 cursor-pointer rounded border border-zinc-200"
                  value={
                    /^#[0-9a-fA-F]{6}$/.test(previewColor)
                      ? previewColor
                      : "#4a6fa5"
                  }
                  onChange={(e) => setColor(e.target.value)}
                />
              </div>
            </div>

            {allowAssign && activeMembers.length > 0 ? (
              <fieldset className="rounded-lg border border-zinc-200 bg-white p-2">
                <legend className="px-1 text-xs text-zinc-500">
                  指派人（可多选，可不选）
                </legend>
                <div className="flex max-h-24 flex-col gap-1 overflow-y-auto">
                  {activeMembers.map((m) => (
                    <label
                      key={m.user_id}
                      className="flex items-center gap-2 text-xs text-zinc-700"
                    >
                      <input
                        type="checkbox"
                        checked={assigneeIds.includes(m.user_id)}
                        onChange={() => toggleAssignee(m.user_id)}
                      />
                      {m.display_name}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-zinc-400">
                  未排期可不选指派人；已填时间且未选时默认指派自己
                </p>
              </fieldset>
            ) : (
              <p className="text-[11px] text-zinc-400">
                普通成员不能指定指派人；未排期可不指派，填时间后将指派给你自己
              </p>
            )}
          </div>
        ) : null}
      </div>

      {/* sticky 底栏：键盘弹起时提交按钮始终可见 */}
      <div className="sticky bottom-0 z-10 mt-1 flex flex-col gap-1 border-t border-zinc-100 bg-white pt-2">
        {msg ? <p className="text-[11px] text-zinc-500">{msg}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-zinc-900 px-3 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "创建中…" : "添加待办"}
        </button>
      </div>
    </form>
  );
}
