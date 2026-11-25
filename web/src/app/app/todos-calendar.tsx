"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type {
  DateSelectArg,
  DatesSetArg,
  EventClickArg,
  EventContentArg,
  EventDropArg,
  EventInput,
} from "@fullcalendar/core";
import type {
  DateClickArg,
  EventDragStopArg,
  EventReceiveArg,
  EventResizeDoneArg,
} from "@fullcalendar/interaction";
import zhCn from "@fullcalendar/core/locales/zh-cn";
import { createClient } from "@/lib/supabase/client";
import { findConflictTodoIds } from "@/lib/conflicts";
import { notifyTodoAssignment } from "@/lib/notify";
import {
  TODO_DELETED,
  TODO_SCHEDULED,
  TODO_UNSCHEDULED,
  TODO_UPSERTED,
  applyTodoDelete,
  applyTodoUpsert,
  emitTodoScheduled,
  emitTodoUnscheduled,
  emitTodoUpserted,
  type TodoDeletedDetail,
  type TodoScheduledDetail,
  type TodoUnscheduledDetail,
  type TodoUpsertedDetail,
} from "@/lib/todo-schedule-events";
import {
  isTodosRealtimeRefreshSuppressed,
  suppressTodosRealtimeRefresh,
} from "@/lib/todos-realtime-gate";
import {
  TODO_SELECT_LEAN,
  allDayRangeToIso,
  localDateKey,
  minutesBetween,
  resolveTodoDurationMinutes,
  todosToEvents,
  type SpaceMemberOption,
  type SpaceNavItem,
  type TodoRow,
} from "@/lib/todos";
import {
  TODOS_REALTIME_CHANGED,
  TODOS_REALTIME_DELETED,
} from "@/lib/use-todos-realtime";
import { loadSpaceCalendarTodos } from "@/lib/space-data-cache";
import { hexToRgba, resolveTaskOpacity } from "@/lib/ui-prefs";
import { CalendarEventTitle } from "./calendar-event-title";
import { chipClass } from "./ui-btn-class";
import { Modal } from "./ui-modal";
import { useUiPrefsOptional } from "./ui-prefs-provider";

const FC_PLUGINS = [dayGridPlugin, timeGridPlugin, interactionPlugin];

/**
 * 手机端专属：3 日横滑视图（桌面完全不注册、不感知）。
 * FullCalendar 自定义 view 的 duration=3 天，prev/next 一次正好翻 3 天，
 * 与手机「整屏翻页」手势天然对齐。
 */
const FC_VIEWS = {
  threeDay: {
    type: "timeGrid",
    duration: { days: 3 },
  },
};

type MobileRange = "day" | "threeDay" | "week" | "month";

function mobileRangeToFcView(range: MobileRange) {
  if (range === "day") return "timeGridDay";
  if (range === "threeDay") return "threeDay";
  if (range === "month") return "dayGridMonth";
  return "timeGridWeek";
}

function todosSignature(list: TodoRow[]) {
  return list
    .map(
      (t) =>
        `${t.id}:${t.start_at}:${t.end_at}:${t.status}:${t.title}:${t.is_all_day}`,
    )
    .join("|");
}

const TodoEditor = dynamic(
  () => import("./todo-editor").then((m) => ({ default: m.TodoEditor })),
  { ssr: false },
);
const QuickCreateTodo = dynamic(
  () =>
    import("./quick-create-todo").then((m) => ({ default: m.QuickCreateTodo })),
  { ssr: false },
);

type CreatePrefill = {
  startLocal: string;
  endLocal: string;
  isAllDay: boolean;
  startDate: string;
};

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDateInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Props = {
  todos: TodoRow[];
  spaces?: SpaceNavItem[];
  defaultSpaceId?: string;
  allowOverview?: boolean;
  members?: SpaceMemberOption[];
  membersBySpace?: Record<string, SpaceMemberOption[]>;
  canAssignBySpace?: Record<string, boolean>;
  title?: string;
  canAssign?: boolean;
  showMineFilter?: boolean;
  mineOnly?: boolean;
  onMineOnlyChange?: (v: boolean) => void;
  /** 手机：去掉说明文案，强化日期切换控件 */
  mobileDateChrome?: boolean;
  /** 隐藏标题与说明条 */
  hideTitle?: boolean;
  /** 与顶栏日/周/月同步（URL range） */
  viewRange?: "day" | "week" | "month";
};

function rangeToFcView(range: "day" | "week" | "month") {
  if (range === "day") return "timeGridDay";
  if (range === "month") return "dayGridMonth";
  return "timeGridWeek";
}

// 手机端日/3日/周/月切换（照搬 view-switcher 的分段样式，不含「全部」）
const MOBILE_RANGES = [
  ["day", "日", "日视图"],
  ["threeDay", "3日", "三日视图"],
  ["week", "周", "周视图"],
  ["month", "月", "月视图"],
] as const;

export function TodosCalendar({
  todos: todosProp,
  spaces = [],
  defaultSpaceId,
  allowOverview = false,
  members = [],
  membersBySpace,
  canAssignBySpace,
  title = "日历",
  canAssign = false,
  showMineFilter = false,
  mineOnly = false,
  onMineOnlyChange,
  mobileDateChrome = false,
  hideTitle = false,
  viewRange = "week",
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const calendarRef = useRef<FullCalendar>(null);
  const [todos, setTodos] = useState(todosProp);
  const todosRef = useRef(todosProp);
  const todosSigRef = useRef("");
  /** 刚拖过的 id：父级 props 同步时保留本地时段，避免整表重绑闪屏 */
  const dirtyTodoIdsRef = useRef(new Set<string>());
  /** 刚「取消排期」的任务 id：强制从日历移除，即便实时回源/父级 props 仍带该任务也绝不重新加回 */
  const unscheduleGuardRef = useRef(new Set<string>());
  todosRef.current = todos;
  const [selected, setSelected] = useState<TodoRow | null>(null);
  /** 消息中心冲突跳转：?focus=todoId */
  const focusFromUrl = searchParams.get("focus");
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [focusPulseId, setFocusPulseId] = useState<string | null>(null);
  const [createPrefill, setCreatePrefill] = useState<CreatePrefill | null>(
    null,
  );
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    todo: TodoRow;
  } | null>(null);
  // 首帧就按视口判定，避免 dynamic(ssr:false) 挂载后先闪一下桌面周视图
  const [isMobile, setIsMobile] = useState(
    () =>
      mobileDateChrome &&
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
  );
  /** 手机端日程清单（点日期标题弹出） */
  const [dayList, setDayList] = useState<{ date: string; label: string } | null>(
    null,
  );
  /** 手机端专属视图：独立 URL 参数 mrange，不污染父级 range（桌面过滤逻辑） */
  const rawMRange = searchParams.get("mrange");
  const [mobileRange, setMobileRange] = useState<MobileRange>(
    rawMRange === "day" ||
      rawMRange === "threeDay" ||
      rawMRange === "week" ||
      rawMRange === "month"
      ? rawMRange
      : "threeDay",
  );
  useEffect(() => {
    if (
      rawMRange === "day" ||
      rawMRange === "threeDay" ||
      rawMRange === "week" ||
      rawMRange === "month"
    ) {
      setMobileRange(rawMRange);
    }
  }, [rawMRange]);
  /**
   * 视图外改动提示：轮询/他人刷新重拉到的是「当前空间全部已排期任务」，
   * 但 FullCalendar 只渲染当前视图时间窗口内的事件。当某个任务落在当前
   * 周/月窗口之外（如相邻周的任务）时，观察端看不到它的变动，表现为
   * 「某某任务不实时」。这里统计「当前视图窗口之外的任务集合」的签名，
   * 一旦该集合发生变化（他人新增/移动/删除窗口外任务），就在日历顶部
   * 提示「其他周的任务有更新 · 共 N 项在视图外」，点击可跳转到其中最早一项所在的日期。
   */
  const [outsideUpdate, setOutsideUpdate] = useState<{
    count: number;
    firstDate: string | null;
  } | null>(null);
  const outsideSigRef = useRef("");
  const outsideInitRef = useRef(false);
  /** 标记「点击查看」触发的程序化跳转，handleDatesSet 据此不重复提示 */
  const programmaticGotoRef = useRef(false);

  // 父级 props 更新：同内容跳过；有 dirty 则按 id 合并时段，避免整表闪
  useEffect(() => {
    const sig = todosSignature(todosProp);
    if (sig === todosSigRef.current) {
      dirtyTodoIdsRef.current.clear();
      return;
    }
    if (isTodosRealtimeRefreshSuppressed()) return;

    const dirty = dirtyTodoIdsRef.current;
    if (dirty.size === 0) {
      todosSigRef.current = sig;
      todosRef.current = todosProp;
      setTodos(todosProp);
      return;
    }

    const localById = new Map(todosRef.current.map((t) => [t.id, t]));
    const merged = todosProp
      .filter((t) => !unscheduleGuardRef.current.has(t.id))
      .map((t) => {
        if (!dirty.has(t.id)) return t;
        const local = localById.get(t.id);
        if (!local) return t;
        // props 已追上本地时段则清 dirty
        if (
          local.start_at === t.start_at &&
          local.end_at === t.end_at &&
          local.is_all_day === t.is_all_day
        ) {
          dirty.delete(t.id);
          return t;
        }
        return {
          ...t,
          start_at: local.start_at,
          end_at: local.end_at,
          is_all_day: local.is_all_day,
          duration_minutes: local.duration_minutes,
        };
      });
    // 本地有、props 暂无的（极少）保留
    for (const id of dirty) {
      const local = localById.get(id);
      if (local && !merged.some((t) => t.id === id)) merged.push(local);
    }
    // 父级已不再携带该任务（服务端已确认取消排期）→ 解除守卫，避免长期屏蔽后续正常排期
    for (const id of [...unscheduleGuardRef.current]) {
      if (!todosProp.some((t) => t.id === id)) unscheduleGuardRef.current.delete(id);
    }

    const mergedSig = todosSignature(merged);
    if (mergedSig === todosSigRef.current) return;
    todosSigRef.current = mergedSig;
    todosRef.current = merged;
    setTodos(merged);
  }, [todosProp]);

  useEffect(() => {
    if (!mobileDateChrome) {
      setIsMobile(false);
      return;
    }
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mobileDateChrome]);

  useEffect(() => {
    // FullCalendar.changeView 内部会 flushSync，须离开当前 React 渲染周期
    const next = isMobile
      ? mobileRangeToFcView(mobileRange)
      : rangeToFcView(viewRange);
    const t = window.setTimeout(() => {
      const api = calendarRef.current?.getApi();
      if (api && api.view.type !== next) api.changeView(next);
    }, 0);
    return () => window.clearTimeout(t);
  }, [viewRange, isMobile, mobileRange]);

  useEffect(() => {
    if (focusFromUrl) setPendingFocus(focusFromUrl);
  }, [focusFromUrl]);

  // 冲突 focus：等待办到位后定位、高亮并打开编辑
  useEffect(() => {
    if (!pendingFocus) return;
    const todo = todos.find((t) => t.id === pendingFocus);
    if (!todo?.start_at) return;

    const focusId = pendingFocus;
    setPendingFocus(null);
    setFocusPulseId(focusId);
    setSelected(todo);

    const go = window.setTimeout(() => {
      const api = calendarRef.current?.getApi();
      if (api) api.gotoDate(new Date(todo.start_at!));
    }, 0);

    const params = new URLSearchParams(searchParams.toString());
    if (params.has("focus")) {
      params.delete("focus");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    }

    const clearPulse = window.setTimeout(() => setFocusPulseId(null), 4500);
    return () => {
      window.clearTimeout(go);
      window.clearTimeout(clearPulse);
    };
  }, [pendingFocus, todos, pathname, router, searchParams]);

  // 本地创建/删除立刻反映到日历（不靠 router.refresh）
  useEffect(() => {
    function onUpsert(ev: Event) {
      const todo = (ev as CustomEvent<TodoUpsertedDetail>).detail?.todo;
      if (!todo?.id) return;
      // 本地打勾完成：立即从日历移除（与 refetch 的 .neq(status,done) 一致），
      // 不等 realtime/轮询重拉，避免「完成还挂在日历上、外观与进行中无差别」。
      if (todo.status === "done") {
        if (!todosRef.current.some((t) => t.id === todo.id)) return;
        const next = applyTodoDelete(todosRef.current, todo.id);
        todosRef.current = next;
        todosSigRef.current = todosSignature(next);
        setTodos(next);
        return;
      }
      if (!todo.start_at) {
        const next = applyTodoDelete(todosRef.current, todo.id);
        todosRef.current = next;
        todosSigRef.current = todosSignature(next);
        setTodos(next);
        return;
      }
      dirtyTodoIdsRef.current.add(todo.id);
      const next = applyTodoUpsert(todosRef.current, todo);
      todosRef.current = next;
      todosSigRef.current = todosSignature(next);
      setTodos(next);
    }
    function onDeleted(ev: Event) {
      const todoId = (ev as CustomEvent<TodoDeletedDetail>).detail?.todoId;
      if (!todoId) return;
      dirtyTodoIdsRef.current.add(todoId);
      const next = applyTodoDelete(todosRef.current, todoId);
      todosRef.current = next;
      todosSigRef.current = todosSignature(next);
      setTodos(next);
      setSelected((cur) => (cur?.id === todoId ? null : cur));
    }
    window.addEventListener(TODO_UPSERTED, onUpsert);
    window.addEventListener(TODO_DELETED, onDeleted);
    return () => {
      window.removeEventListener(TODO_UPSERTED, onUpsert);
      window.removeEventListener(TODO_DELETED, onDeleted);
    };
  }, []);

  // 远程实时：他人增/改/改排期/删除任务，日历自己重拉最新的已排期数据，
  // 不依赖父级 todosProp 传值——即使将来日历被单独渲染也能实时同步。
  const spaceIdsKey = useMemo(() => {
    const ids: string[] = [];
    if (spaces?.length) ids.push(...spaces.map((s) => s.id));
    if (ids.length === 0 && defaultSpaceId) ids.push(defaultSpaceId);
    return Array.from(new Set(ids)).join(",");
  }, [spaces, defaultSpaceId]);

  useEffect(() => {
    const ids = spaceIdsKey.split(",").filter(Boolean);
    if (ids.length === 0) return;
    let cancelled = false;

    function refetch(force = false) {
      if (!force && isTodosRealtimeRefreshSuppressed()) return;
      void Promise.all(ids.map((id) => loadSpaceCalendarTodos(id))).then(
        (caches) => {
          if (cancelled) return;
          const scheduled = caches.flatMap((c) => c.scheduled ?? []);
          const localById = new Map(todosRef.current.map((t) => [t.id, t]));
          // 保留本地刚拖动的时段，避免被服务端快照覆盖而闪屏；
          // 但「刚取消排期」的任务（在 unscheduleGuard 中）即便服务端因竞态仍返回已排期，
          // 也绝不重新加回日历——修复拖到未排期后日历仍显示、需刷新才消失。
          const merged = scheduled
            .filter((t) => !unscheduleGuardRef.current.has(t.id))
            .map((t) => {
              if (dirtyTodoIdsRef.current.has(t.id)) {
                const local = localById.get(t.id);
                if (local) {
                  return {
                    ...t,
                    start_at: local.start_at,
                    end_at: local.end_at,
                    is_all_day: local.is_all_day,
                    duration_minutes: local.duration_minutes,
                  };
                }
              }
              return t;
            });
          todosRef.current = merged;
          todosSigRef.current = todosSignature(merged);
          setTodos(merged);
          // 服务端已确认该任务不在已排期集合中 → 解除守卫，避免长期屏蔽其后续正常排期
          for (const id of [...unscheduleGuardRef.current]) {
            if (!scheduled.some((t) => t.id === id)) unscheduleGuardRef.current.delete(id);
          }

          // 视图外改动提示：只关心「当前视图窗口之外」的任务集合是否变化。
          // 首次仅记录基线不提示（避免一进页面就提示「其他周有 N 项」）；
          // 之后集合变化才提示，确保只看得到窗口内的用户不会漏掉窗口外的改动。
          const { sig, count, firstDate } = computeOutsideFromList(scheduled);
          if (!outsideInitRef.current) {
            outsideInitRef.current = true;
            outsideSigRef.current = sig;
          } else if (sig !== outsideSigRef.current) {
            setOutsideUpdate(count > 0 ? { count, firstDate } : null);
            outsideSigRef.current = sig;
          }
        },
      );
    }

    function onRemoteDeleted(ev: Event) {
      if (isTodosRealtimeRefreshSuppressed()) return;
      const todoId = (ev as CustomEvent<{ todoId: string }>).detail?.todoId;
      if (!todoId) return;
      const next = applyTodoDelete(todosRef.current, todoId);
      todosRef.current = next;
      todosSigRef.current = todosSignature(next);
      setTodos(next);
      setSelected((cur) => (cur?.id === todoId ? null : cur));
    }

    // 本地乐观更新（编辑器保存 / 删除 / 改指派）：永不被静音闸门挡住，
    // 否则「自己改完指派，自己的日历卡片不实时更新」只能靠手动刷新。
    // 远端 realtime 回显仍走 TODOS_REALTIME_CHANGED（受闸门保护，避免抖动）。
    function onLocalUpserted(ev: Event) {
      const todo = (ev as CustomEvent<TodoUpsertedDetail>).detail?.todo;
      if (!todo) return;
      // 本地打勾完成：立即从日历移除（与 refetch 的 .neq(status,done) 一致），
      // 不再等 realtime/轮询重拉，避免完成态任务滞留且无视觉区分。
      if (todo.status === "done") {
        if (!todosRef.current.some((t) => t.id === todo.id)) return;
        const next = applyTodoDelete(todosRef.current, todo.id);
        todosRef.current = next;
        todosSigRef.current = todosSignature(next);
        setTodos(next);
        return;
      }
      // 重新排期（拿到 start_at）意味着不再是「未排期」，解除对应守卫，避免被误屏蔽
      if (todo.start_at) unscheduleGuardRef.current.delete(todo.id);
      // 日历只渲染已排期任务；未排期且本就不在列表里的不混入
      if (!todo.start_at && !todosRef.current.some((t) => t.id === todo.id))
        return;
      const next = applyTodoUpsert(todosRef.current, todo);
      todosRef.current = next;
      todosSigRef.current = todosSignature(next);
      setTodos(next);
    }
    function onLocalDeleted(ev: Event) {
      const todoId = (ev as CustomEvent<TodoDeletedDetail>).detail?.todoId;
      if (!todoId) return;
      const next = applyTodoDelete(todosRef.current, todoId);
      todosRef.current = next;
      todosSigRef.current = todosSignature(next);
      setTodos(next);
      setSelected((cur) => (cur?.id === todoId ? null : cur));
    }
    // 排期 / 取消排期由其他组件触发，本视图无增量数据，force 重拉一次
    function onLocalScheduled(ev?: Event) {
      // 从「未排期」拖回日历：解除守卫，否则 ≤8s 内仍会被守卫误屏蔽
      const todoId = (ev as CustomEvent<TodoScheduledDetail>)?.detail?.todoId;
      if (todoId) unscheduleGuardRef.current.delete(todoId);
      refetch(true);
    }
    function onLocalUnscheduled(ev?: Event) {
      const todoId = (ev as CustomEvent<TodoUnscheduledDetail>)?.detail?.todo?.id;
      if (todoId) {
        // 本地刚取消排期：加入守卫，避免 force 重拉因服务端竞态仍返回已排期而被重新加回
        unscheduleGuardRef.current.add(todoId);
        // 安全网：竞态窗口（远小于 6s 静音）过后解除，避免长期屏蔽该任务后续正常排期
        setTimeout(() => unscheduleGuardRef.current.delete(todoId), 8000);
      }
      refetch(true);
    }

    const onRealtimeChanged = () => refetch();
    window.addEventListener(TODOS_REALTIME_CHANGED, onRealtimeChanged);
    window.addEventListener(TODOS_REALTIME_DELETED, onRemoteDeleted);
    window.addEventListener(TODO_UPSERTED, onLocalUpserted);
    window.addEventListener(TODO_DELETED, onLocalDeleted);
    window.addEventListener(TODO_SCHEDULED, onLocalScheduled);
    window.addEventListener(TODO_UNSCHEDULED, onLocalUnscheduled);
    return () => {
      cancelled = true;
      window.removeEventListener(TODOS_REALTIME_CHANGED, onRealtimeChanged);
      window.removeEventListener(TODOS_REALTIME_DELETED, onRemoteDeleted);
      window.removeEventListener(TODO_UPSERTED, onLocalUpserted);
      window.removeEventListener(TODO_DELETED, onLocalDeleted);
      window.removeEventListener(TODO_SCHEDULED, onLocalScheduled);
      window.removeEventListener(TODO_UNSCHEDULED, onLocalUnscheduled);
    };
  }, [spaceIdsKey]);

  /** 统计「当前 FC 视图窗口之外」的任务集合，返回签名/数量/最早一项日期 */
  function computeOutsideFromList(list: TodoRow[]) {
    const api = calendarRef.current?.getApi();
    const view = api?.view;
    if (!view) return { sig: "", count: 0, firstDate: null as string | null };
    const start = view.activeStart.getTime();
    const end = view.activeEnd.getTime();
    let count = 0;
    let sig = "";
    let firstDate: string | null = null;
    for (const t of list) {
      if (!t.start_at) continue;
      const s = new Date(t.start_at).getTime();
      const e = t.end_at ? new Date(t.end_at).getTime() : s;
      // 与视图窗口有任何交集即视为「在视图内」
      if (e > start && s < end) continue;
      count++;
      sig += `${t.id}:${t.start_at}:${t.end_at}:${t.status}|`;
      const d = new Date(t.start_at);
      if (!firstDate || d.getTime() < new Date(firstDate).getTime()) {
        firstDate = t.start_at;
      }
    }
    return { sig, count, firstDate };
  }

  /** 翻页/切换视图：用户主动浏览，清提示并把基线同步到当前视图 */
  function handleDatesSet(_info: DatesSetArg) {
    const { sig, count, firstDate } = computeOutsideFromList(todosRef.current);
    outsideSigRef.current = sig;
    // 由「点击查看」程序化跳转触发的日期变更：已带用户去看变动项，
    // 不再重复提示，避免点完立刻又冒出黄条
    if (programmaticGotoRef.current) {
      programmaticGotoRef.current = false;
      setOutsideUpdate(null);
      return;
    }
    setOutsideUpdate(count > 0 ? { count, firstDate } : null);
  }

  /** 点击徽标：跳转到最早一个视图外任务所在日期 */
  function jumpToOutside() {
    if (!outsideUpdate?.firstDate) return;
    const api = calendarRef.current?.getApi();
    if (api) {
      programmaticGotoRef.current = true;
      api.gotoDate(new Date(outsideUpdate.firstDate));
    }
    setOutsideUpdate(null);
  }

  const editorMembers = selected
    ? (membersBySpace?.[selected.space_id] ?? members)
    : members;
  const editorCanAssign = selected
    ? (canAssignBySpace?.[selected.space_id] ?? canAssign)
    : canAssign;

  const uiPrefs = useUiPrefsOptional()?.globalPrefs;
  const conflictIds = useMemo(() => findConflictTodoIds(todos), [todos]);

  const events = useMemo(() => {
    const base = todosToEvents(todos, uiPrefs) as EventInput[];
    return base.map((ev) => {
      const id = String(ev.id);
      const classes: string[] = [];
      if (conflictIds.has(id)) classes.push("fc-event-conflict");
      if (focusPulseId === id) classes.push("fc-event-focus");
      if (conflictIds.has(id)) {
        return {
          ...ev,
          classNames: classes,
          backgroundColor: "#dc2626",
          borderColor: "#b91c1c",
          textColor: "#ffffff",
        };
      }
      if (classes.length > 0) {
        return { ...ev, classNames: classes };
      }
      return ev;
    });
  }, [todos, conflictIds, uiPrefs, focusPulseId]);

  /**
   * 时间轴范围：默认 07:00–22:00，按当前事件向两端自动扩展。
   *
   * 此前写死 slotMinTime=07:00 / slotMaxTime=22:00，导致早于 7 点或晚于 22 点的
   * 任务在日历上完全不渲染 —— 待办列表里看得到、日历上没有，用户以为数据丢了。
   */
  const slotRange = useMemo(() => {
    const DEFAULT_MIN = 7 * 60;
    const DEFAULT_MAX = 22 * 60;
    let minMin = DEFAULT_MIN;
    let maxMin = DEFAULT_MAX;

    for (const ev of events) {
      if (ev.allDay) continue;
      const startRaw = ev.start as string | number | Date | undefined;
      if (startRaw === undefined || startRaw === null) continue;
      const s = new Date(startRaw);
      if (Number.isNaN(s.getTime())) continue;
      const endRaw = ev.end as string | number | Date | undefined;
      const parsedEnd =
        endRaw !== undefined && endRaw !== null ? new Date(endRaw) : null;
      const e =
        parsedEnd && !Number.isNaN(parsedEnd.getTime())
          ? parsedEnd
          : new Date(s.getTime() + 60 * 60 * 1000);
      const sMin = s.getHours() * 60 + s.getMinutes();
      const eMin =
        e.getTime() > s.getTime() &&
        e.getFullYear() * 10000 + (e.getMonth() + 1) * 100 + e.getDate() >
          s.getFullYear() * 10000 + (s.getMonth() + 1) * 100 + s.getDate()
          ? 24 * 60
          : e.getHours() * 60 + e.getMinutes();
      minMin = Math.min(minMin, Math.floor(sMin / 60) * 60);
      maxMin = Math.max(maxMin, Math.ceil(eMin / 60) * 60);
    }

    const min = Math.max(0, Math.min(minMin, 23 * 60));
    const max = Math.min(24 * 60, Math.max(maxMin, min + 60));
    const toHms = (mins: number) =>
      `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;
    return { min: toHms(min), max: toHms(max) };
  }, [events]);

  async function persistRange(
    todoId: string,
    start: Date | null,
    end: Date | null,
    allDay: boolean,
    opts?: { fromDrag?: boolean; revert?: () => void },
  ): Promise<boolean> {
    if (!start) return false;
    let startIso: string;
    let endIso: string;
    if (allDay) {
      // FC 全天 end 为 exclusive；用本地日期，避免 UTC 切日偏一天
      const startYmd = localDateKey(start);
      const endExclusiveYmd = end ? localDateKey(end) : null;
      const range = allDayRangeToIso(startYmd, endExclusiveYmd);
      startIso = range.start_at;
      endIso = range.end_at;
    } else {
      startIso = start.toISOString();
      endIso = end
        ? end.toISOString()
        : new Date(start.getTime() + 60 * 60 * 1000).toISOString();
    }

    const duration_minutes = allDay
      ? null
      : minutesBetween(startIso, endIso);

    // 拖拽：全局 suppress（window），避免双模块失效；时长覆盖 notify 延迟
    if (opts?.fromDrag) suppressTodosRealtimeRefresh(6000);

    const { error: upErr } = await supabase
      .from("todos")
      .update({
        start_at: startIso,
        end_at: endIso,
        is_all_day: allDay,
        duration_minutes,
      })
      .eq("id", todoId);

    if (upErr) {
      setError(upErr.message);
      opts?.revert?.();
      if (!opts?.fromDrag) router.refresh();
      return false;
    }

    let next: TodoRow[];
    const exists = todosRef.current.some((t) => t.id === todoId);
    if (exists) {
      next = todosRef.current.map((t) =>
        t.id === todoId
          ? {
              ...t,
              start_at: startIso,
              end_at: endIso,
              is_all_day: allDay,
              duration_minutes,
            }
          : t,
      );
    } else {
      // 从未排期拖入：日历列表里原先没有这条
      const { data: row } = await supabase
        .from("todos")
        .select(TODO_SELECT_LEAN)
        .eq("id", todoId)
        .maybeSingle();
      next = row
        ? [...todosRef.current, row as unknown as TodoRow]
        : todosRef.current;
    }
    // 同步 state，立刻重算冲突标红（findConflictTodoIds 依赖 todos）
    todosRef.current = next;
    todosSigRef.current = todosSignature(next);
    dirtyTodoIdsRef.current.add(todoId);
    setTodos(next);
    void notifyTodoAssignment(todoId);
    setError("");
    return true;
  }

  async function clearSchedule(todoId: string, opts?: { revert?: () => void }) {
    suppressTodosRealtimeRefresh(6000);
    const todo = todosRef.current.find((t) => t.id === todoId);
    const duration_minutes = todo
      ? resolveTodoDurationMinutes(todo)
      : null;

    // 立刻出现在未排期 / 移出日历
    if (todo) emitTodoUnscheduled(todo);
    const next = todosRef.current.filter((t) => t.id !== todoId);
    todosRef.current = next;
    todosSigRef.current = todosSignature(next);
    dirtyTodoIdsRef.current.add(todoId);
    setTodos(next);

    const { error: upErr } = await supabase
      .from("todos")
      .update({
        start_at: null,
        end_at: null,
        is_all_day: false,
        ...(duration_minutes != null ? { duration_minutes } : {}),
      })
      .eq("id", todoId);
    if (upErr) {
      setError(upErr.message);
      emitTodoScheduled(todoId);
      if (todo) {
        const restored = [todo, ...todosRef.current];
        todosRef.current = restored;
        todosSigRef.current = todosSignature(restored);
        setTodos(restored);
      }
      opts?.revert?.();
      return;
    }
    setMenu(null);
    setError("");
  }

  async function copyTodo(todo: TodoRow) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("请先登录");
      return;
    }
    // 已排期副本保留时段（整体后移 1 小时避免完全重叠），可直接在日历上拖
    let start_at = todo.start_at;
    let end_at = todo.end_at;
    if (start_at && end_at && !todo.is_all_day) {
      const shift = 60 * 60 * 1000;
      start_at = new Date(new Date(start_at).getTime() + shift).toISOString();
      end_at = new Date(new Date(end_at).getTime() + shift).toISOString();
    }
    const { data: created, error: cErr } = await supabase
      .from("todos")
      .insert({
        space_id: todo.space_id,
        creator_id: user.id,
        title: `${todo.title}（副本）`,
        description: todo.description,
        priority: todo.priority,
        status: "todo",
        start_at,
        end_at,
        is_all_day: todo.is_all_day,
        due_at: todo.due_at,
        source: "manual",
        parent_todo_id: todo.parent_todo_id ?? null,
      })
      .select("id")
      .single();
    if (cErr || !created) {
      setError(cErr?.message || "复制失败");
      return;
    }
    const assignees =
      (todo.todo_assignees ?? []).map((a) => a.user_id).length > 0
        ? (todo.todo_assignees ?? []).map((a) => a.user_id)
        : [user.id];
    await supabase.from("todo_assignees").insert(
      assignees.map((user_id) => ({ todo_id: created.id, user_id })),
    );
    suppressTodosRealtimeRefresh(3000);
    await notifyTodoAssignment(created.id);
    const assigneesRows = assignees.map((user_id) => ({ user_id }));
    const next: TodoRow[] = [
      ...todosRef.current,
      {
        ...todo,
        id: created.id,
        title: `${todo.title}（副本）`,
        status: "todo",
        start_at,
        end_at,
        todo_assignees: assigneesRows,
      },
    ];
    todosRef.current = next;
    todosSigRef.current = todosSignature(next);
    setTodos(next);
    emitTodoUpserted(next[next.length - 1]!);
    setMenu(null);
    setError("");
  }

  function onEventClick(info: EventClickArg) {
    setMenu(null);
    setCreatePrefill(null);
    const todo = todos.find((t) => t.id === info.event.id) || null;
    setSelected(todo);
  }

  function openCreateAt(start: Date, end: Date | null, allDay: boolean) {
    if (spaces.length === 0) {
      setError("暂无可用空间，请先创建空间");
      return;
    }
    setMenu(null);
    setSelected(null);
    if (allDay) {
      setCreatePrefill({
        startLocal: "",
        endLocal: "",
        isAllDay: true,
        startDate: toDateInput(start),
      });
      return;
    }
    const startLocal = toLocalInput(start);
    const endDate =
      end ?? new Date(start.getTime() + 60 * 60 * 1000);
    setCreatePrefill({
      startLocal,
      endLocal: toLocalInput(endDate),
      isAllDay: false,
      startDate: "",
    });
  }

  function onDateClick(info: DateClickArg) {
    const end = info.allDay
      ? null
      : new Date(info.date.getTime() + 60 * 60 * 1000);
    openCreateAt(info.date, end, info.allDay);
  }

  function onDateSelect(info: DateSelectArg) {
    if (!info.start) return;
    openCreateAt(info.start, info.end, info.allDay);
    info.view.calendar.unselect();
  }

  async function onEventDrop(info: EventDropArg) {
    await persistRange(
      info.event.id,
      info.event.start,
      info.event.end,
      info.event.allDay,
      { fromDrag: true, revert: () => info.revert() },
    );
  }

  async function onEventResize(info: EventResizeDoneArg) {
    await persistRange(
      info.event.id,
      info.event.start,
      info.event.end,
      info.event.allDay,
      { fromDrag: true, revert: () => info.revert() },
    );
  }

  async function onEventReceive(info: EventReceiveArg) {
    // 从未排期拖入：先从未排期移除，写库失败再加回
    suppressTodosRealtimeRefresh(6000);
    const todoId = info.event.id;
    emitTodoScheduled(todoId);
    const ok = await persistRange(
      todoId,
      info.event.start,
      info.event.end,
      info.event.allDay,
      { revert: () => info.revert() },
    );
    if (!ok) {
      const { data: row } = await supabase
        .from("todos")
        .select(TODO_SELECT_LEAN)
        .eq("id", todoId)
        .maybeSingle();
      if (row) emitTodoUnscheduled(row as unknown as TodoRow);
    }
  }

  function setUnscheduledDropActive(on: boolean) {
    const zone = document.getElementById("unscheduled-drop-zone");
    if (!zone) return;
    zone.classList.toggle("ring-2", on);
    zone.classList.toggle("ring-[var(--brand)]", on);
    zone.classList.toggle("border-[var(--brand)]", on);
    zone.classList.toggle("bg-brand-soft", on);
  }

  function onEventDragStart() {
    setUnscheduledDropActive(true);
  }

  async function onEventDragStop(info: EventDragStopArg) {
    setUnscheduledDropActive(false);
    const zone = document.getElementById("unscheduled-drop-zone");
    if (!zone) return;
    const rect = zone.getBoundingClientRect();
    const { clientX: x, clientY: y } = info.jsEvent;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const removed = info.event;
      removed.remove();
      await clearSchedule(removed.id, {
        revert: () => {
          // 失败时靠 props/refresh 恢复；FC 事件已 remove
          todosSigRef.current = "";
          setTodos([...todosRef.current]);
        },
      });
    }
  }

  function renderEventContent(arg: EventContentArg) {
    const todoTitle =
      (arg.event.extendedProps.todoTitle as string | undefined)?.trim() ||
      arg.event.title;
    // 卡片里只显示标题：时间由事件在时间轴上的位置/时长表达，指派人不在日历里看
    // 手机端内边距略放大，让窄列里的标题有呼吸、色块更高更好点
    return (
      <div
        className={
          isMobile
            ? "fc-event-stack px-1 py-1 leading-snug"
            : "fc-event-stack px-0.5 py-0.5 leading-snug"
        }
      >
        <CalendarEventTitle
          title={todoTitle}
          className={[
            "block w-full truncate font-semibold leading-snug",
            isMobile ? "text-[12px]" : "text-[15px] md:text-[14px]",
          ].join(" ")}
        />
      </div>
    );
  }

  // 手机端日/3日/周/月：
  // - mrange：手机视图档位（含 3日），只手机认，桌面完全不感知
  // - range ：父级数据拉取/过滤范围（OverviewRange 无 threeDay，映射到 week，周覆盖 3 天）
  //   不写 range 会导致「切到月视图但父级只按周拉数据」→ 月视图缺任务
  function patchMobileRange(next: MobileRange) {
    setMobileRange(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("mrange", next);
    params.set("range", next === "threeDay" ? "week" : next);
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  }

  /** 手机：整屏滑动翻页。3 日视图 duration=3，prev/next 一次正好翻 3 天。 */
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    if (!isMobile || e.touches.length !== 1) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!isMobile || !start || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    // 横向有效、纵向偏移不能过大（避免把时间轴纵向滚动误判成翻页）
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
    const api = calendarRef.current?.getApi();
    if (!api) return;
    if (dx < 0) api.next();
    else api.prev();
  }

  /** 手机：点日期标题 → 底部弹出当天任务清单 */
  function onDayHeaderClick(info: { date: Date; text: string }) {
    setDayList({
      date: toDateInput(info.date),
      label: info.text,
    });
  }

  /** 当天清单的任务：按本地日期匹配 start，全天/跨天按区间覆盖 */
  const dayListTodos = useMemo(() => {
    if (!dayList) return [];
    return todos
      .filter((t) => {
        if (!t.start_at) return false;
        const s = new Date(t.start_at);
        if (Number.isNaN(s.getTime())) return false;
        // 多日任务的中间日期也算覆盖
        const end = t.end_at ? new Date(t.end_at) : s;
        const d = new Date(`${dayList.date}T00:00:00`);
        return s <= d && d <= (Number.isNaN(end.getTime()) ? s : end);
      })
      .sort((a, b) => {
        const sa = a.start_at ? new Date(a.start_at).getTime() : 0;
        const sb = b.start_at ? new Date(b.start_at).getTime() : 0;
        return sa - sb;
      });
  }, [dayList, todos]);

  return (
    <div
      className={[
        "rounded-xl border border-zinc-200 bg-white md:p-4",
        mobileDateChrome
          ? "sharetodo-cal-mobile -mx-4 -mb-4 border-0 p-0 md:mx-0 md:mb-0 md:rounded-xl md:border md:p-4"
          : "p-3",
      ].join(" ")}
    >
      {hideTitle ? null : (
        <div
          className={[
            "mb-3 flex flex-wrap items-center justify-between gap-2",
            mobileDateChrome ? "hidden md:flex" : "",
          ].join(" ")}
        >
          <h2 className="text-sm font-medium text-zinc-700">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {showMineFilter && onMineOnlyChange ? (
              <button
                type="button"
                onClick={() => onMineOnlyChange(!mineOnly)}
                className={chipClass(mineOnly)}
              >
                个人任务
              </button>
            ) : null}
            {conflictIds.size > 0 ? (
              <p className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white">
                {conflictIds.size} 项冲突 · 红色标出
              </p>
            ) : (
              <p className="text-xs text-zinc-400">无时段冲突</p>
            )}
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
          </div>
        </div>
      )}

      {/* 手机：错误仍单行提示；冲突缩成分段控件右侧的小角标，不再单独占一行 */}
      {mobileDateChrome && error ? (
        <p className="mb-1 text-[11px] text-red-600 md:hidden">{error}</p>
      ) : null}

      {hideTitle ? null : (
        <p
          className={[
            "mb-2 text-[11px] text-zinc-400",
            mobileDateChrome ? "hidden md:block" : "",
          ].join(" ")}
        >
          点击空白处创建任务；点击已有任务可编辑；拖回侧栏「未排期」可取消排期
        </p>
      )}

      {outsideUpdate ? (
        <button
          type="button"
          onClick={jumpToOutside}
          className="mb-2 flex w-full items-center justify-center gap-1 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200 transition hover:bg-amber-100"
        >
          其他周的任务有更新 · 共 {outsideUpdate.count} 项在视图外 · 点击查看
        </button>
      ) : null}

      {isMobile ? (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-1 md:hidden">
          <div
            className="inline-flex shrink-0 overflow-hidden rounded-lg border border-[var(--border-muted)] bg-white"
            role="group"
            aria-label="时间范围"
          >
            {MOBILE_RANGES.map(([key, label, title]) => {
              const active = mobileRange === key;
              return (
                <button
                  key={key}
                  type="button"
                  title={title}
                  aria-label={title}
                  aria-pressed={active}
                  onClick={() => patchMobileRange(key)}
                  className={[
                    "px-2.5 py-1 text-xs transition-colors duration-200",
                    active
                      ? "bg-[var(--brand)] font-medium text-white"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {conflictIds.size > 0 ? (
            <button
              type="button"
              title="查看冲突任务"
              onClick={() => {
                const first = todos.find((t) => conflictIds.has(t.id));
                if (first) setSelected(first);
              }}
              className="shrink-0 rounded-full bg-red-50 px-2 py-1 text-[11px] font-medium text-red-600"
            >
              ● {conflictIds.size} 冲突
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        className="fc-theme sharetodo-calendar text-sm"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={(e) => {
          if (!isMobile) return;
          const cell = (e.target as HTMLElement).closest<HTMLElement>(
            ".fc-col-header-cell[data-date]",
          );
          if (!cell) return;
          const ymd = cell.dataset.date;
          if (!ymd) return;
          const d = new Date(`${ymd}T12:00:00`);
          onDayHeaderClick({ date: d, text: cell.textContent?.trim() || ymd });
        }}
        onContextMenu={(e) => {
          const target = (e.target as HTMLElement).closest(".fc-event");
          if (!target) return;
          e.preventDefault();
          const id =
            target.getAttribute("data-event-id") ||
            (target as HTMLElement).dataset?.eventId;
          // FullCalendar stores id on fc-event via arg - fallback: find by title
          const el = target as HTMLElement;
          const fcId =
            el.getAttribute("data-event") ||
            Array.from(todos).find((t) =>
              el.textContent?.includes(t.title),
            )?.id;
          const todo = todos.find(
            (t) => t.id === id || t.id === fcId || el.textContent?.includes(t.title),
          );
          if (todo) {
            setMenu({ x: e.clientX, y: e.clientY, todo });
          }
        }}
      >
        <FullCalendar
          ref={calendarRef}
          plugins={FC_PLUGINS}
          views={FC_VIEWS}
          initialView={isMobile ? mobileRangeToFcView(mobileRange) : rangeToFcView(viewRange)}
          headerToolbar={
            isMobile
              ? {
                  left: "prev,next",
                  center: "today",
                  right: "title",
                }
              : {
                  left: "prev,next today",
                  center: "title",
                  right: "",
                }
          }
          locale={zhCn}
          height={isMobile ? "100%" : "auto"}
          expandRows={isMobile}
          nowIndicator
          editable
          droppable
          /* 拖到日历之外的「未排期待办」投放区属 FC 眼中的「无效落点」，
             默认会播放 500ms 回退动画（镜像飞回日历原位置）再被我们移除，
             表现为「任务先弹回日历」。关掉回退动画即可让影子直接消失并落入未排期。 */
          dragRevertDuration={0}
          /* 主内容容器有 backdrop-blur，会为内部 position:fixed 的拖拽镜像建立包含块，
             导致镜像相对容器定位而非视口，出现「任务与鼠标错位一大截」。
             把镜像挂到 body（在 blur 容器之外）即可让 fixed 回归视口坐标系。 */
          fixedMirrorParent={
            typeof document !== "undefined" ? document.body : undefined
          }
          selectable
          selectMirror
          eventDurationEditable
          eventStartEditable
          events={events}
          eventContent={renderEventContent}
          dateClick={onDateClick}
          select={onDateSelect}
          eventClick={onEventClick}
          eventDrop={onEventDrop}
          eventResize={onEventResize}
          eventReceive={onEventReceive}
          eventDragStart={onEventDragStart}
          eventDragStop={onEventDragStop}
          datesSet={handleDatesSet}
          eventDidMount={(arg) => {
            arg.el.setAttribute("data-event-id", arg.event.id);
            const taskOpacity = resolveTaskOpacity(uiPrefs);
            const glassMobile =
              mobileDateChrome &&
              typeof window !== "undefined" &&
              window.matchMedia("(max-width: 767px)").matches;
            if (glassMobile && !conflictIds.has(arg.event.id)) {
              const raw =
                (arg.event.extendedProps.solidColor as string | undefined) ||
                arg.event.backgroundColor ||
                (arg.event.extendedProps.color as string | undefined) ||
                "#5cb88a";
              const alpha = Math.min(0.9, taskOpacity);
              arg.el.classList.add("fc-event-glass");
              arg.el.style.setProperty(
                "background-color",
                hexToRgba(raw, alpha),
                "important",
              );
              arg.el.style.setProperty("border-color", "transparent", "important");
              arg.el.style.setProperty("color", "#ffffff", "important");
              const stack = arg.el.querySelector(".fc-event-stack");
              if (stack instanceof HTMLElement) {
                stack.style.setProperty("color", "#ffffff", "important");
              }
            } else if (
              !conflictIds.has(arg.event.id) &&
              taskOpacity < 0.999
            ) {
              const raw =
                (arg.event.extendedProps.quadrantBg as string | undefined) ||
                (arg.event.extendedProps.solidColor as string | undefined) ||
                arg.event.backgroundColor ||
                "#5cb88a";
              arg.el.style.setProperty(
                "background-color",
                hexToRgba(raw, taskOpacity),
                "important",
              );
              arg.el.style.setProperty(
                "border-color",
                hexToRgba(raw, Math.min(1, taskOpacity + 0.05)),
                "important",
              );
            }
            if (conflictIds.has(arg.event.id)) {
              arg.el.classList.add("fc-event-conflict");
              arg.el.style.setProperty("background-color", "#dc2626", "important");
              arg.el.style.setProperty("border-color", "#b91c1c", "important");
              arg.el.style.setProperty("color", "#ffffff", "important");
              const stack = arg.el.querySelector(".fc-event-stack");
              if (stack instanceof HTMLElement) {
                stack.style.setProperty("color", "#ffffff", "important");
              }
            }
            if (focusPulseId === arg.event.id) {
              arg.el.classList.add("fc-event-focus");
            }
            arg.el.addEventListener("contextmenu", (ev) => {
              ev.preventDefault();
              const todo = todos.find((t) => t.id === arg.event.id);
              if (!todo) return;
              setMenu({
                x: (ev as MouseEvent).clientX,
                y: (ev as MouseEvent).clientY,
                todo,
              });
            });
          }}
          buttonText={{
            today: "今天",
            month: "月",
            week: "周",
            day: "日",
          }}
          slotLabelFormat={
            isMobile
              ? { hour: "2-digit", omitZeroMinute: true, hour12: false }
              : undefined
          }
          slotMinTime={slotRange.min}
          slotMaxTime={slotRange.max}
          allDayText="全天"
          allDaySlot
          dayMaxEvents={false}
        />
      </div>

      {isMobile &&
      !dayList &&
      !createPrefill &&
      !selected &&
      typeof document !== "undefined"
        ? createPortal(
            <button
              type="button"
              aria-label="新建任务"
              onClick={() => {
                const now = new Date();
                openCreateAt(
                  now,
                  new Date(now.getTime() + 60 * 60 * 1000),
                  false,
                );
              }}
              className="fixed bottom-20 right-4 z-[60] flex h-12 w-12 items-center justify-center rounded-full bg-[var(--brand)] text-3xl font-light leading-none text-white shadow-lg active:scale-95"
            >
              +
            </button>,
            document.body,
          )
        : null}

      {menu ? (
        <div
          className="fixed z-[70] min-w-[8rem] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50"
            onClick={() => copyTodo(menu.todo)}
          >
            复制（保留排期）
          </button>
          <button
            type="button"
            className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50"
            onClick={() => {
              setSelected(menu.todo);
              setMenu(null);
            }}
          >
            编辑
          </button>
          <button
            type="button"
            className="block w-full px-3 py-2 text-left text-sm text-zinc-500 hover:bg-zinc-50"
            onClick={() => setMenu(null)}
          >
            取消
          </button>
        </div>
      ) : null}

      {isMobile && dayList ? (
        <Modal
          open
          onClose={() => setDayList(null)}
          title={`${dayList.date} 当天任务`}
          variant="bottom"
        >
          <div className="flex max-h-[70vh] flex-col">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-zinc-900">
                {dayList.label}
              </h2>
              <button
                type="button"
                onClick={() => setDayList(null)}
                className="text-sm text-zinc-500 hover:text-zinc-800"
              >
                关闭
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {dayListTodos.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-400">
                  这天暂无已排期任务
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100">
                  {dayListTodos.map((t) => {
                    const start = t.start_at ? new Date(t.start_at) : null;
                    const time = start
                      ? `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`
                      : "";
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setDayList(null);
                            setSelected(t);
                          }}
                          className="flex w-full items-center gap-3 py-2.5 text-left"
                        >
                          <span className="w-10 shrink-0 font-mono text-xs text-zinc-400">
                            {t.is_all_day ? "全天" : time}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-zinc-800">
                            {t.title}
                          </span>
                          {conflictIds.has(t.id) ? (
                            <span className="shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] text-red-600">
                              冲突
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setDayList(null);
                const start = new Date(`${dayList.date}T09:00:00`);
                openCreateAt(start, new Date(start.getTime() + 60 * 60 * 1000), false);
              }}
              className="mt-3 w-full rounded-lg bg-[var(--brand)] py-2 text-sm font-medium text-white"
            >
              + 在这天新建任务
            </button>
          </div>
        </Modal>
      ) : null}

      {selected ? (
        <TodoEditor
          todo={selected}
          members={editorMembers}
          canAssign={editorCanAssign}
          open
          onClose={() => setSelected(null)}
        />
      ) : null}

      {createPrefill && spaces.length > 0 ? (
        <Modal
          open
          onClose={() => setCreatePrefill(null)}
          title="新建待办"
          variant="bottom"
        >
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-zinc-900">新建待办</h2>
              <button
                type="button"
                onClick={() => setCreatePrefill(null)}
                className="text-sm text-zinc-500 hover:text-zinc-800"
              >
                关闭
              </button>
            </div>
            <QuickCreateTodo
                  key={`${createPrefill.startLocal}-${createPrefill.startDate}-${createPrefill.isAllDay}`}
                  spaces={spaces}
                  defaultSpaceId={defaultSpaceId}
                  allowOverview={allowOverview}
                  members={members}
                  membersBySpace={membersBySpace}
                  canAssign={canAssign}
                  bare
                  initialStartLocal={createPrefill.startLocal}
                  initialEndLocal={createPrefill.endLocal}
                  initialIsAllDay={createPrefill.isAllDay}
                  initialStartDate={createPrefill.startDate}
                  onCreated={() => {
                    setCreatePrefill(null);
                  }}
                />
          </div>
        </Modal>
      ) : null}

      <style jsx global>{`
        .sharetodo-calendar .fc {
          --fc-border-color: #e5e7eb;
          --fc-page-bg-color: #ffffff;
          --fc-neutral-bg-color: #f6f8fa;
          --fc-today-bg-color: #e6f1fb;
          --fc-now-indicator-color: #185fa5;
          --fc-button-bg-color: #ffffff;
          --fc-button-border-color: #e2e6ea;
          --fc-button-text-color: #3a3f42;
          --fc-button-hover-bg-color: #eef2f6;
          --fc-button-hover-border-color: #d5dbe1;
          --fc-button-active-bg-color: #e6f1fb;
          --fc-button-active-border-color: #185fa5;
        }
        .sharetodo-calendar .fc-day-today {
          background-color: var(--fc-today-bg-color) !important;
        }
        .sharetodo-calendar .fc-toolbar-title {
          font-size: 1rem;
          font-weight: 600;
          color: var(--brand-ink);
        }
        .sharetodo-calendar .fc-button {
          font-size: 0.75rem;
          font-weight: 500;
          padding: 0.3rem 0.6rem;
          border-radius: 0.5rem;
          text-transform: none;
          box-shadow: none;
          transition: background-color 0.15s, border-color 0.15s, color 0.15s;
        }
        .sharetodo-calendar .fc-button-primary {
          color: var(--brand-ink);
        }
        .sharetodo-calendar .fc-button-primary:not(:disabled):hover {
          color: #1f2a33;
        }
        .sharetodo-calendar .fc-button-primary:disabled {
          opacity: 0.45;
        }
        .sharetodo-calendar .fc-button-primary:not(:disabled).fc-button-active,
        .sharetodo-calendar .fc-button-primary:not(:disabled):active {
          color: var(--brand);
        }
        .sharetodo-calendar .fc-button:focus-visible {
          box-shadow: 0 0 0 3px rgba(24, 95, 165, 0.18);
        }
        /* prev/next 合并成一组：只保留外侧圆角，中间不留双边框 */
        .sharetodo-calendar .fc .fc-button-group > .fc-button:first-child {
          border-top-left-radius: 0.5rem;
          border-bottom-left-radius: 0.5rem;
          border-top-right-radius: 0;
          border-bottom-right-radius: 0;
        }
        .sharetodo-calendar .fc .fc-button-group > .fc-button:last-child {
          border-top-right-radius: 0.5rem;
          border-bottom-right-radius: 0.5rem;
          border-top-left-radius: 0;
          border-bottom-left-radius: 0;
          margin-left: -1px;
        }
        /* 今天：浅蓝底 + 品牌蓝字，作为明确的「回到今天」动作 */
        .sharetodo-calendar .fc .fc-today-button {
          background: #e6f1fb;
          border-color: #185fa5;
          color: #185fa5;
          font-weight: 600;
        }
        .sharetodo-calendar .fc .fc-today-button:not(:disabled):hover {
          background: #d7e8f8;
          border-color: #185fa5;
          color: #185fa5;
        }
        .sharetodo-calendar .fc .fc-today-button:disabled {
          opacity: 0.5;
        }
        .sharetodo-calendar .fc-col-header-cell {
          background: #f6f8fa;
        }
        .sharetodo-calendar .fc-col-header-cell-cushion {
          color: #6b7280;
          font-size: 0.78rem;
          font-weight: 500;
          padding: 0.25rem 0;
        }
        .sharetodo-calendar
          .fc-col-header-cell.fc-day-today
          .fc-col-header-cell-cushion {
          color: var(--brand);
        }
        .sharetodo-calendar .fc-event-conflict,
        .sharetodo-calendar .fc-event-conflict .fc-event-main,
        .sharetodo-calendar .fc-event-conflict .fc-event-title {
          background-color: #dc2626 !important;
          border-color: #b91c1c !important;
          color: #fff !important;
        }
        .sharetodo-calendar .fc-event-conflict {
          box-shadow: 0 0 0 2px #fecaca;
        }
        .sharetodo-calendar .fc-event-focus {
          box-shadow: 0 0 0 3px #fbbf24, 0 0 0 6px rgba(251, 191, 36, 0.35) !important;
          z-index: 5 !important;
          animation: fc-focus-pulse 1.2s ease-in-out 2;
        }
        @keyframes fc-focus-pulse {
          0%,
          100% {
            filter: brightness(1);
          }
          50% {
            filter: brightness(1.15);
          }
        }
        .sharetodo-calendar .fc-timegrid-event {
          min-height: 2.5rem;
        }
        /* 拖拽/改时长：原任务始终可见；拖影改为半透明预览 */
        .fc-event-mirror,
        .fc-event-mirror.fc-event {
          opacity: 0.55 !important;
          visibility: visible !important;
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.12) !important;
          pointer-events: none !important;
        }
        /* 不再对 .fc-event-dragging 设 opacity:0，原任务在整个拖拽期间保持显示 */
        .sharetodo-calendar .fc-timegrid-event .fc-event-main,
        .sharetodo-calendar .fc-timegrid-event .fc-event-main-frame {
          overflow: visible;
          height: auto;
        }
        /* 月视图：每天格子固定高度，格内滚动看全部任务 */
        .sharetodo-calendar .fc-dayGridMonth-view .fc-daygrid-day-frame {
          min-height: 6.5rem !important;
          height: 6.5rem !important;
          max-height: 6.5rem !important;
          overflow-x: hidden;
          overflow-y: auto;
        }
        .sharetodo-calendar .fc-dayGridMonth-view .fc-daygrid-day-events {
          min-height: 0 !important;
        }
        .sharetodo-calendar .fc-dayGridMonth-view .fc-daygrid-event-harness {
          margin-top: 1px;
        }
        .sharetodo-calendar .fc-dayGridMonth-view .fc-daygrid-body,
        .sharetodo-calendar .fc-dayGridMonth-view .fc-scrollgrid-sync-table {
          height: auto !important;
        }
        /* 手机：满高 + 节次感时间格 + 半透明色块（无虚线网格） */
        @media (max-width: 767px) {
          .sharetodo-cal-mobile {
            padding: 0 !important;
            border: none !important;
            background: transparent !important;
            border-radius: 0 !important;
          }
          .sharetodo-cal-mobile .sharetodo-calendar,
          .sharetodo-cal-mobile .fc {
            height: calc(
              100dvh - 10.25rem - env(safe-area-inset-top, 0px) -
                env(safe-area-inset-bottom, 0px)
            ) !important;
            --fc-border-color: rgba(113, 113, 122, 0.22);
            --fc-today-bg-color: rgba(24, 95, 165, 0.16);
            --fc-page-bg-color: transparent;
            --fc-neutral-bg-color: rgba(255, 255, 255, 0.2);
          }
          .sharetodo-cal-mobile .fc-scrollgrid,
          .sharetodo-cal-mobile .fc-scrollgrid td,
          .sharetodo-cal-mobile .fc-scrollgrid th {
            border-style: solid !important;
          }
          .sharetodo-cal-mobile .fc-timegrid-slot {
            /* 接近课表单节高度 */
            height: 2.85rem !important;
            min-height: 2.85rem !important;
          }
          /* 时间轴收窄：周视图 7 列太挤，砍掉分钟、缩字号，把宽度让给 7 个日期列 */
          .sharetodo-cal-mobile .fc-timegrid-slot-label-cushion {
            padding: 0 3px !important;
            font-size: 0.625rem !important;
            line-height: 1 !important;
            color: #8a9099;
          }
          .sharetodo-cal-mobile .fc-timegrid-axis-frame {
            width: auto !important;
          }
          .sharetodo-cal-mobile .fc-timegrid-event,
          .sharetodo-cal-mobile .fc-event-glass {
            border-radius: 0.45rem !important;
            border: none !important;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
          }
          .sharetodo-cal-mobile .fc-event-stack {
            color: #fff !important;
          }
          .sharetodo-cal-mobile .fc-header-toolbar {
            display: flex;
            flex-direction: row;
            flex-wrap: nowrap;
            align-items: center;
            justify-content: space-between;
            gap: 0.25rem;
            margin-bottom: 0.25rem;
          }
          .sharetodo-cal-mobile .fc-toolbar-chunk {
            display: flex;
            align-items: center;
            justify-content: center;
            flex-wrap: nowrap;
            gap: 0.25rem;
            min-width: 0;
          }
          .sharetodo-cal-mobile .fc-toolbar-title {
            font-size: 0.8rem;
            font-weight: 600;
            text-align: right;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 42vw;
          }
          .sharetodo-cal-mobile .fc-prev-button,
          .sharetodo-cal-mobile .fc-next-button {
            background: #ffffff !important;
            border: 1px solid #e2e6ea !important;
            color: #3a3f42 !important;
            border-radius: 0.5rem;
            min-width: 2.25rem;
            min-height: 2.25rem;
          }
          .sharetodo-cal-mobile .fc-prev-button:active,
          .sharetodo-cal-mobile .fc-next-button:active {
            background: #eef2f6 !important;
          }
          .sharetodo-cal-mobile .fc-today-button {
            background: #e6f1fb !important;
            border: 1px solid #185fa5 !important;
            color: #185fa5 !important;
            border-radius: 0.5rem;
            width: auto;
            max-width: none;
            padding: 0.35rem 0.85rem !important;
            font-weight: 600 !important;
          }
          .sharetodo-cal-mobile .fc-today-button:disabled {
            opacity: 0.5;
          }
          .sharetodo-cal-mobile .fc-button-group {
            border-radius: 0.5rem;
            overflow: hidden;
          }
          .sharetodo-cal-mobile .fc-event-stack {
            color: inherit;
            overflow: visible;
          }
          .sharetodo-cal-mobile .fc-timegrid-event {
            min-height: 2.5rem !important;
          }
          .sharetodo-cal-mobile .fc-timegrid-event .fc-event-main,
          .sharetodo-cal-mobile .fc-timegrid-event .fc-event-main-frame {
            overflow: visible !important;
            height: auto !important;
            padding: 2px 3px;
          }
          .sharetodo-cal-mobile .fc-dayGridMonth-view .fc-daygrid-day-frame {
            min-height: 5rem !important;
            height: 5rem !important;
            max-height: 5rem !important;
          }
          /* 3 日横滑：列数少、每列更宽；日期标题加大并提示可点开当天清单 */
          .sharetodo-cal-mobile .fc-threeDay-view .fc-col-header-cell-cushion {
            font-size: 0.9rem !important;
            font-weight: 600 !important;
            padding: 0.45rem 0 !important;
          }
          .sharetodo-cal-mobile .fc-threeDay-view .fc-col-header-cell {
            cursor: pointer;
          }
          .sharetodo-cal-mobile .fc-threeDay-view .fc-timegrid-slot {
            height: 3.1rem !important;
            min-height: 3.1rem !important;
          }
          /* 满屏沉浸：顶栏元素压缩后把日历主体高度补满 */
          .sharetodo-cal-mobile .sharetodo-calendar,
          .sharetodo-cal-mobile .fc {
            height: calc(
              100dvh - 8.25rem - env(safe-area-inset-top, 0px) -
                env(safe-area-inset-bottom, 0px)
            ) !important;
          }
          /* 日期标题统一加大点按区域（日/3日/周视图） */
          .sharetodo-cal-mobile .fc-col-header-cell-cushion {
            padding: 0.35rem 0 !important;
          }
        }
      `}</style>
    </div>
  );
}
