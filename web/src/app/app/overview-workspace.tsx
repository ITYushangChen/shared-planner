"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
} from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  TODO_DELETED,
  TODO_SCHEDULED,
  TODO_UNSCHEDULED,
  TODO_UPSERTED,
  applyTodoDelete,
  applyTodoUpsert,
  type TodoDeletedDetail,
  type TodoScheduledDetail,
  type TodoUnscheduledDetail,
  type TodoUpsertedDetail,
} from "@/lib/todo-schedule-events";
import { TODOS_REALTIME_CHANGED, TODOS_REALTIME_DELETED } from "@/lib/use-todos-realtime";
import {
  TODO_SELECT_LEAN,
  canViewerSeeTodo,
  getOverviewBounds,
  isAssignedToUser,
  todoOverlapsRange,
  type OverviewRange,
  type SpaceMemberOption,
  type SpaceNavItem,
  type TodoRow,
} from "@/lib/todos";
import { useWatchSpaceMembers } from "@/lib/use-watch-space-members";
// 优先首屏：日历/列表/未排期均拆包
const TodoListPanel = dynamic(
  () =>
    import("./todo-list-panel").then((m) => ({ default: m.TodoListPanel })),
  { loading: () => null },
);
const OverviewBoards = dynamic(
  () =>
    import("./overview-boards").then((m) => ({ default: m.OverviewBoards })),
  { ssr: false, loading: () => null },
);
const TodosCalendar = dynamic(
  () =>
    import("./todos-calendar").then((m) => ({ default: m.TodosCalendar })),
  // 占位不闪脉冲：只留高度，避免骨架→日历再晃一下
  { ssr: false, loading: () => <div className="min-h-[420px]" aria-busy /> },
);
type Props = {
  todos: TodoRow[];
  scheduled: TodoRow[];
  unscheduled: TodoRow[];
  completed?: TodoRow[];
  spaces?: SpaceNavItem[];
  membersBySpace: Record<string, SpaceMemberOption[]>;
  canAssignBySpace: Record<string, boolean>;
  /** 日历首屏未带已排期：立即客户端拉取当前窗口 */
  deferScheduled?: boolean;
  /** 日历首屏未带未排期：空闲后客户端补拉 */
  deferUnscheduled?: boolean;
};

const SCHEDULED_CLIENT_LIMIT = 80;
const UNSCHEDULED_CLIENT_LIMIT = 40;

type OverviewTab = "boards" | "calendar" | "list";

function parseTab(raw: string | null): OverviewTab {
  if (raw === "boards") return "boards";
  if (raw === "calendar") return "calendar";
  if (raw === "list") return "list";
  return "boards"; // 首页默认四象限看板
}

function parseRange(raw: string | null): OverviewRange | "all" {
  if (raw === "day" || raw === "month" || raw === "week") return raw;
  if (raw === "all") return "all";
  return "week"; // 默认周
}

export function OverviewWorkspace({
  todos: todosProp,
  scheduled: scheduledProp,
  unscheduled: unscheduledProp,
  completed = [],
  spaces = [],
  membersBySpace: membersBySpaceProp,
  canAssignBySpace,
  deferScheduled = false,
  deferUnscheduled = false,
}: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawTab = parseTab(searchParams.get("view"));
  const range = parseRange(searchParams.get("range"));
  const assigneeId = searchParams.get("assignee") || "";
  const [isMobile, setIsMobile] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [membersBySpace, setMembersBySpace] = useState(membersBySpaceProp);
  const [scheduledExtra, setScheduledExtra] = useState<TodoRow[]>([]);
  const [unscheduledExtra, setUnscheduledExtra] = useState<TodoRow[]>([]);
  /** 远端实时事件驱动的完整主列表（覆盖 RSC props），避免只刷新溢出 extra */
  const [scheduledLocal, setScheduledLocal] = useState<TodoRow[] | null>(null);
  const scheduledPropSigRef = useRef("");
  const [unscheduledLocal, setUnscheduledLocal] =
    useState<TodoRow[]>(unscheduledProp);
  const [scheduledRefreshing, setScheduledRefreshing] = useState(false);
  /** 乐观删除：从服务端 props 合并时排除 */
  const [removedIds, setRemovedIds] = useState(() => new Set<string>());
  const rangeFetchKeyRef = useRef<string | null>(null);
  const unschedPropSigRef = useRef("");
  // 手机端（≤767px）不再展示四象限看板：boards 一律落到待办列表；桌面不受影响
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  // 手机端首页「只看自己的待办」需要当前用户 id
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await createClient().auth.getUser();
      if (!cancelled) setCurrentUserId(data.user?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const tab: OverviewTab =
    isMobile && rawTab === "boards" ? "list" : rawTab;
  const spaceFilterIds = useMemo(() => {
    const raw = searchParams.get("spaces");
    if (!raw?.trim()) return [] as string[];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }, [searchParams]);

  // 稳定依赖：避免 RSC refresh 时 spaces/canAssign 新引用触发重拉闪屏
  const spaceIdsKey = useMemo(
    () => spaces.map((s) => s.id).join(","),
    [spaces],
  );
  const canAssignKey = useMemo(
    () =>
      spaces
        .map((s) => `${s.id}:${canAssignBySpace[s.id] ? "1" : "0"}`)
        .join(","),
    [spaces, canAssignBySpace],
  );

  const membersPropSigRef = useRef("");
  // 空对象不覆盖本地成员；同签名跳过，避免 URL 切换无谓 setState
  useEffect(() => {
    const keys = Object.keys(membersBySpaceProp);
    if (keys.length === 0) return;
    const sig = keys
      .sort()
      .map(
        (sid) =>
          `${sid}:${(membersBySpaceProp[sid] ?? [])
            .map((m) => m.user_id)
            .join(",")}`,
      )
      .join("|");
    if (sig === membersPropSigRef.current) return;
    membersPropSigRef.current = sig;
    setMembersBySpace(membersBySpaceProp);
  }, [membersBySpaceProp]);

  // 服务端未排期变化时同步；同 id 集合跳过，避免盖掉本地拖拽结果
  useEffect(() => {
    const sig = unscheduledProp.map((t) => t.id).join(",");
    if (sig === unschedPropSigRef.current) return;
    unschedPropSigRef.current = sig;
    setUnscheduledLocal(unscheduledProp);
  }, [unscheduledProp]);

  // 已排期：RSC props 变化时同步进本地主列表（远端实时刷新走 scheduledLocal 直写）
  useEffect(() => {
    const sig = scheduledProp.map((t) => t.id).join(",");
    if (sig === scheduledPropSigRef.current) return;
    scheduledPropSigRef.current = sig;
    setScheduledLocal(scheduledProp);
  }, [scheduledProp]);

  // 日历 ↔ 未排期 / 创建删除 本地同步
  useEffect(() => {
    function onUnscheduled(ev: Event) {
      const todo = (ev as CustomEvent<TodoUnscheduledDetail>).detail?.todo;
      if (!todo?.id) return;
      setRemovedIds((prev) => {
        if (!prev.has(todo.id)) return prev;
        const next = new Set(prev);
        next.delete(todo.id);
        return next;
      });
      setUnscheduledLocal((prev) => applyTodoUpsert(prev, todo));
      setScheduledExtra((prev) => applyTodoDelete(prev, todo.id));
    }
    function onScheduled(ev: Event) {
      const todoId = (ev as CustomEvent<TodoScheduledDetail>).detail?.todoId;
      if (!todoId) return;
      setUnscheduledLocal((prev) => applyTodoDelete(prev, todoId));
    }
    function onUpsert(ev: Event) {
      const todo = (ev as CustomEvent<TodoUpsertedDetail>).detail?.todo;
      if (!todo?.id) return;
      setRemovedIds((prev) => {
        if (!prev.has(todo.id)) return prev;
        const next = new Set(prev);
        next.delete(todo.id);
        return next;
      });
      if (todo.start_at) {
        setScheduledExtra((prev) => applyTodoUpsert(prev, todo));
        setUnscheduledLocal((prev) => applyTodoDelete(prev, todo.id));
      } else {
        setUnscheduledLocal((prev) => applyTodoUpsert(prev, todo));
        setScheduledExtra((prev) => applyTodoDelete(prev, todo.id));
      }
    }
    function onDeleted(ev: Event) {
      const todoId = (ev as CustomEvent<TodoDeletedDetail>).detail?.todoId;
      if (!todoId) return;
      setRemovedIds((prev) => new Set(prev).add(todoId));
      setUnscheduledLocal((prev) => applyTodoDelete(prev, todoId));
      setScheduledExtra((prev) => applyTodoDelete(prev, todoId));
    }
    window.addEventListener(TODO_UNSCHEDULED, onUnscheduled);
    window.addEventListener(TODO_SCHEDULED, onScheduled);
    window.addEventListener(TODO_UPSERTED, onUpsert);
    window.addEventListener(TODO_DELETED, onDeleted);
    return () => {
      window.removeEventListener(TODO_UNSCHEDULED, onUnscheduled);
      window.removeEventListener(TODO_SCHEDULED, onScheduled);
      window.removeEventListener(TODO_UPSERTED, onUpsert);
      window.removeEventListener(TODO_DELETED, onDeleted);
    };
  }, []);

  // 服务端已带已排期时同步进本地缓存；同内容不 setState，避免 refresh 闪一下
  const scheduledSigRef = useRef("");
  useEffect(() => {
    if (scheduledProp.length === 0) return;
    const sig = scheduledProp
      .map((t) => `${t.id}:${t.start_at}:${t.end_at}:${t.status}`)
      .join("|");
    if (sig === scheduledSigRef.current) return;
    scheduledSigRef.current = sig;
    setScheduledExtra(scheduledProp);
  }, [scheduledProp]);

  // 仅 deferScheduled 且服务端为空时客户端补拉；range 变化才标 refreshing
  useEffect(() => {
    if (!deferScheduled || !spaceIdsKey) return;
    if (scheduledProp.length > 0) return;
    let cancelled = false;
    const calRange: OverviewRange =
      range === "day" || range === "month" || range === "week"
        ? range
        : "week";
    const fetchKey = `${spaceIdsKey}|${calRange}|${canAssignKey}`;
    const rangeChanged =
      rangeFetchKeyRef.current != null &&
      rangeFetchKeyRef.current.split("|")[1] !== calRange;
    rangeFetchKeyRef.current = fetchKey;

    const { start, end } = getOverviewBounds(calRange);
    const windowStart = new Date(start.getTime() - 2 * 24 * 60 * 60 * 1000);
    // 与 /app/page.tsx 一致：改成区间相交，避免跨周期长任务在日历上消失
    const windowStartIso = windowStart.toISOString();
    const calStartIso = start.toISOString();
    const calEndIso = end.toISOString();
    const supabase = createClient();
    const spaceIds = spaceIdsKey.split(",").filter(Boolean);
    if (rangeChanged) setScheduledRefreshing(true);
    void (async () => {
      // ⚠️ 此前整个 async 没有 catch：一旦 getUser() 或查询 reject，
      // setScheduledRefreshing(false) 永不执行，日历区永久停在「加载中」灰态。
      try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data } = await supabase
        .from("todos")
        .select(TODO_SELECT_LEAN)
        .in("space_id", spaceIds)
        .neq("status", "done")
        .not("start_at", "is", null)
        .lt("start_at", calEndIso)
        .or(`start_at.gte.${windowStartIso},end_at.gte.${calStartIso}`)
        .order("start_at", { ascending: true })
        .limit(SCHEDULED_CLIENT_LIMIT);
      if (cancelled) return;
      const assignMap = Object.fromEntries(
        canAssignKey.split(",").filter(Boolean).map((pair) => {
          const [id, flag] = pair.split(":");
          return [id, flag === "1"];
        }),
      ) as Record<string, boolean>;
      const rows = ((data ?? []) as unknown as TodoRow[]).filter((t) =>
        canViewerSeeTodo(t, {
          currentUserId: user?.id,
          isOwnerOrAdmin: !!assignMap[t.space_id],
        }),
      );
      setScheduledExtra(rows);
      } catch {
        if (cancelled) return;
        setScheduledExtra([]);
      } finally {
        if (!cancelled) setScheduledRefreshing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deferScheduled, spaceIdsKey, canAssignKey, range, scheduledProp.length]);

  // 日历首屏未带未排期：空闲后补拉（稳定依赖，避免 refresh 重复打）
  useEffect(() => {
    if (!deferUnscheduled || !spaceIdsKey) return;
    if (unscheduledProp.length > 0) return;
    let cancelled = false;
    const spaceIds = spaceIdsKey.split(",").filter(Boolean);
    const assignMap = Object.fromEntries(
      canAssignKey.split(",").filter(Boolean).map((pair) => {
        const [id, flag] = pair.split(":");
        return [id, flag === "1"];
      }),
    ) as Record<string, boolean>;
    const run = () => {
      const supabase = createClient();
      void (async () => {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        const { data } = await supabase
          .from("todos")
          .select(TODO_SELECT_LEAN)
          .in("space_id", spaceIds)
          .neq("status", "done")
          .is("start_at", null)
          .order("created_at", { ascending: false })
          .limit(UNSCHEDULED_CLIENT_LIMIT);
        if (cancelled || !data) return;
        const rows = (data as unknown as TodoRow[]).filter((t) =>
          canViewerSeeTodo(t, {
            currentUserId: user?.id,
            isOwnerOrAdmin: !!assignMap[t.space_id],
          }),
        );
        setUnscheduledExtra(rows);
      })();
    };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(run, { timeout: 900 });
    } else {
      timeoutId = setTimeout(run, 450);
    }
    return () => {
      cancelled = true;
      if (idleId != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [deferUnscheduled, spaceIdsKey, canAssignKey, unscheduledProp.length]);

  // 远端实时：收到别人增删改/改指派事件后，完整重拉「当前用户所有空间」的待办，
  // 直接覆盖主列表状态（unscheduledLocal / scheduledLocal），而不是只补溢出 extra。
  // 这是让概览页真正实时的关键——之前只重拉溢出 overflow，主列表（RSC props）从不更新，
  // 体感就是「完全不实时」。本地拖拽走本地乐观事件，且被静音闸门拦截，不会走到这里。
  const refetchAllTodos = useCallback(async () => {
    if (!spaceIdsKey) return;
    const spaceIds = spaceIdsKey.split(",").filter(Boolean);
    if (spaceIds.length === 0) return;
    const assignMap = Object.fromEntries(
      canAssignKey.split(",").filter(Boolean).map((pair) => {
        const [id, flag] = pair.split(":");
        return [id, flag === "1"];
      }),
    ) as Record<string, boolean>;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const [uRes, sRes] = await Promise.all([
      supabase
        .from("todos")
        .select(TODO_SELECT_LEAN)
        .in("space_id", spaceIds)
        .neq("status", "done")
        .is("start_at", null)
        .order("created_at", { ascending: false }),
      supabase
        .from("todos")
        .select(TODO_SELECT_LEAN)
        .in("space_id", spaceIds)
        .neq("status", "done")
        .not("start_at", "is", null)
        .order("start_at", { ascending: true }),
    ]);
    const canSee = (t: TodoRow) =>
      canViewerSeeTodo(t, {
        currentUserId: user?.id ?? null,
        isOwnerOrAdmin: !!assignMap[t.space_id],
      });
    setUnscheduledLocal(
      ((uRes.data ?? []) as unknown as TodoRow[]).filter(canSee),
    );
    setScheduledLocal(
      ((sRes.data ?? []) as unknown as TodoRow[]).filter(canSee),
    );
  }, [spaceIdsKey, canAssignKey]);

  // 增量补丁：只拉改动的那一行（RLS 已按可见性过滤），merge 进主列表状态，
  // 不再整列表全量重拉——owner 大数据集下整列表替换正是「加载慢」根因。
  // 跨「已排期↔未排期」迁移、可见性变化（移出空间/撤指派）都在此归位或剔除。
  const patchTodo = useCallback(
    async (todoId: string) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("todos")
        .select(TODO_SELECT_LEAN)
        .eq("id", todoId)
        .maybeSingle();
      const row = (data ?? null) as TodoRow | null;
      if (error || !row) {
        // 不再可见（被删 / 移出空间 / 指派被撤且非成员）→ 从两列表剔除
        setRemovedIds((prev) => {
          if (prev.has(todoId)) return prev;
          const next = new Set(prev);
          next.add(todoId);
          return next;
        });
        setUnscheduledLocal((prev) => prev.filter((t) => t.id !== todoId));
        setScheduledLocal((prev) =>
          prev ? prev.filter((t) => t.id !== todoId) : prev,
        );
        return;
      }
      // 可见：解除 removedIds 屏蔽，并按 start_at/status 归位到正确列表
      setRemovedIds((prev) => {
        if (!prev.has(todoId)) return prev;
        const next = new Set(prev);
        next.delete(todoId);
        return next;
      });
      const isDone = row.status === "done";
      const inScheduled = !isDone && row.start_at != null;
      const inUnscheduled = !isDone && row.start_at == null;
      setUnscheduledLocal((prev) => {
        const base = prev.length > 0 ? prev : unscheduledProp;
        if (!inUnscheduled) {
          const filtered = base.filter((t) => t.id !== row.id);
          return filtered.length === base.length ? base : filtered;
        }
        const map = new Map(base.map((t) => [t.id, t]));
        map.set(row.id, row);
        return [...map.values()];
      });
      setScheduledLocal((prev) => {
        const base = prev ?? scheduledProp;
        if (!inScheduled) {
          const filtered = base.filter((t) => t.id !== row.id);
          return filtered.length === base.length ? base : filtered;
        }
        const map = new Map(base.map((t) => [t.id, t]));
        map.set(row.id, row);
        return [...map.values()];
      });
    },
    [unscheduledProp, scheduledProp],
  );

  useEffect(() => {
    function onRemoteChange(ev?: Event) {
      const todoId = (
        ev as (Event & { detail?: { todoId?: string } }) | null
      )?.detail?.todoId;
      if (todoId) {
        // 单条改动 → 增量打补丁（亚秒级、对称，不再整列表重拉）
        void patchTodo(todoId);
      } else {
        // 无单条 id（改指派 / 轮询兜底）→ 完整重拉
        void refetchAllTodos();
      }
    }
    window.addEventListener(
      TODOS_REALTIME_CHANGED,
      onRemoteChange as EventListener,
    );
    return () =>
      window.removeEventListener(
        TODOS_REALTIME_CHANGED,
        onRemoteChange as EventListener,
      );
  }, [patchTodo, refetchAllTodos]);

  // 订阅远程删除：别人删任务时精准隐藏（加进 removedIds，最终渲染统一过滤）
  useEffect(() => {
    function onRemoteDeleted(ev: Event) {
      const todoId = (ev as CustomEvent<{ todoId: string }>).detail?.todoId;
      if (!todoId) return;
      setRemovedIds((prev) => {
        if (prev.has(todoId)) return prev;
        const next = new Set(prev);
        next.add(todoId);
        return next;
      });
    }
    window.addEventListener(TODOS_REALTIME_DELETED, onRemoteDeleted);
    return () =>
      window.removeEventListener(TODOS_REALTIME_DELETED, onRemoteDeleted);
  }, []);

  // 服务端 + 本地乐观更新合并（本地 upsert 覆盖同 id；removed 立刻隐藏）
  const scheduled = useMemo(() => {
    const base = scheduledLocal ?? scheduledProp;
    const map = new Map<string, TodoRow>();
    for (const t of base) {
      if (!removedIds.has(t.id)) map.set(t.id, t);
    }
    for (const t of scheduledExtra) {
      if (!removedIds.has(t.id)) map.set(t.id, t);
    }
    return [...map.values()];
  }, [scheduledLocal, scheduledProp, scheduledExtra, removedIds]);
  const unscheduled = useMemo(() => {
    const map = new Map<string, TodoRow>();
    const base =
      unscheduledLocal.length > 0 || unschedPropSigRef.current !== ""
        ? unscheduledLocal
        : unscheduledExtra;
    for (const t of base) {
      if (!removedIds.has(t.id)) map.set(t.id, t);
    }
    if (base === unscheduledLocal && unscheduledExtra.length > 0) {
      for (const t of unscheduledExtra) {
        if (!removedIds.has(t.id) && !map.has(t.id)) map.set(t.id, t);
      }
    }
    return [...map.values()];
  }, [unscheduledLocal, unscheduledExtra, removedIds]);
  const todos = useMemo(() => {
    const map = new Map<string, TodoRow>();
    for (const t of todosProp) {
      if (!removedIds.has(t.id)) map.set(t.id, t);
    }
    for (const t of scheduled) map.set(t.id, t);
    for (const t of unscheduled) map.set(t.id, t);
    return [...map.values()];
  }, [todosProp, scheduled, unscheduled, removedIds]);

  const membersFetchedForRef = useRef("");
  const hasMembersProp = Object.keys(membersBySpaceProp).length > 0;

  const fetchMembersBySpace = useCallback(() => {
    if (!spaceIdsKey) return;
    const spaceIds = spaceIdsKey.split(",").filter(Boolean);
    const supabase = createClient();
    void supabase
      .from("space_members")
      .select("user_id, space_id, profiles(display_name, email)")
      .in("space_id", spaceIds)
      .then(({ data }: { data: any[] | null }) => {
        if (!data) return;
        const next: Record<string, SpaceMemberOption[]> = {};
        for (const row of data) {
          const raw = row.profiles as unknown;
          const profile = (
            Array.isArray(raw) ? raw[0] : raw
          ) as { display_name: string; email: string | null } | null | undefined;
          const sid = row.space_id as string;
          if (!next[sid]) next[sid] = [];
          next[sid].push({
            user_id: row.user_id as string,
            display_name: profile?.display_name ?? "成员",
            email: profile?.email ?? null,
          });
        }
        membersPropSigRef.current = spaceIds
          .sort()
          .map(
            (sid) =>
              `${sid}:${(next[sid] ?? []).map((m) => m.user_id).join(",")}`,
          )
          .join("|");
        membersFetchedForRef.current = spaceIdsKey;
        setMembersBySpace(next);
      });
  }, [spaceIdsKey]);

  // 仅服务端未带成员时补拉；用 hasMembersProp 布尔依赖，避免 URL 切换反复 cancel
  useEffect(() => {
    if (hasMembersProp) {
      membersFetchedForRef.current = spaceIdsKey;
      return;
    }
    if (membersFetchedForRef.current === spaceIdsKey) return;
    fetchMembersBySpace();
  }, [hasMembersProp, spaceIdsKey, fetchMembersBySpace]);

  // 订阅所关注空间的成员变更：任一成员加入/退出即重拉，避免指派列表陈旧
  useWatchSpaceMembers(
    spaceIdsKey ? spaceIdsKey.split(",").filter(Boolean) : [],
    fetchMembersBySpace,
  );

  const flatMembers = useMemo(() => {
    const map = new Map<string, SpaceMemberOption>();
    for (const list of Object.values(membersBySpace)) {
      for (const m of list) map.set(m.user_id, m);
    }
    return [...map.values()];
  }, [membersBySpace]);

  const canAssignAny = Object.values(canAssignBySpace).some(Boolean);

  const filterTodos = useCallback(
    (list: TodoRow[]) => {
      let next = list;
      if (spaceFilterIds.length > 0) {
        const set = new Set(spaceFilterIds);
        next = next.filter((t) => set.has(t.space_id));
      }
      if (assigneeId) {
        next = next.filter((t) => isAssignedToUser(t, assigneeId));
      }
      return next;
    },
    [assigneeId, spaceFilterIds],
  );

  // 手机端首页「只看自己的待办」：自己创建的 + 指派给自己的；未取到用户时不过滤
  const isOwnTodo = useCallback(
    (t: TodoRow) => {
      if (!currentUserId) return true;
      return (
        t.creator_id === currentUserId || isAssignedToUser(t, currentUserId)
      );
    },
    [currentUserId],
  );

  const filteredTodos = useMemo(
    () => filterTodos(todos),
    [todos, filterTodos],
  );
  const filteredScheduled = useMemo(
    () => filterTodos(scheduled),
    [scheduled, filterTodos],
  );
  const filteredUnscheduled = useMemo(
    () => filterTodos(unscheduled),
    [unscheduled, filterTodos],
  );
  const filteredCompleted = useMemo(
    () => filterTodos(completed),
    [completed, filterTodos],
  );

  const boardsOpen = useMemo(() => {
    if (range === "all") return filteredTodos;
    const { start, end } = getOverviewBounds(range);
    return filteredTodos.filter((t) => todoOverlapsRange(t, start, end));
  }, [filteredTodos, range]);

  const boardsDone = useMemo(() => {
    if (range === "all") return filteredCompleted;
    const { start, end } = getOverviewBounds(range);
    return filteredCompleted.filter((t) => todoOverlapsRange(t, start, end));
  }, [filteredCompleted, range]);

  // 当前时间范围外、被隐藏于象限之外的「已排期」待办数量（用于空态引导"查看全部"）。
  // todoOverlapsRange 对未排期返回 true（未排期另用「未排期」区块展示），
  // 故以「已排期总数 - 已排期且在范围内」精确统计，避免误算未排期任务。
  const hiddenCount = useMemo(() => {
    if (range === "all") return 0;
    const scheduledTotal = filteredTodos.filter((t) => t.start_at).length;
    const scheduledInRange = boardsOpen.filter((t) => t.start_at).length;
    return Math.max(0, scheduledTotal - scheduledInRange);
  }, [filteredTodos, boardsOpen, range]);

  const onShowAll = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", "all");
    startTransition(() => {
      router.replace(`${pathname ?? "/app"}?${params.toString()}`, {
        scroll: false,
      });
    });
  }, [searchParams, router, pathname]);

  return (
    <div
      className={[
        "flex flex-col",
        tab === "calendar" ? "gap-0 md:gap-4" : "gap-4",
      ].join(" ")}
    >
      {tab === "boards" ? (
        <OverviewBoards
          groupBy="priority"
          todos={boardsOpen}
          completed={boardsDone}
          members={flatMembers}
          canAssign={canAssignAny}
          spaces={spaces}
          boardRange="all"
        />
      ) : null}

      {tab === "calendar" ? (
        <div
          className={
            scheduledRefreshing && filteredScheduled.length > 0
              ? "opacity-70 transition-opacity duration-200"
              : "transition-opacity duration-200"
          }
          aria-busy={scheduledRefreshing || undefined}
        >
          <TodosCalendar
            todos={
              isMobile ? filteredScheduled.filter(isOwnTodo) : filteredScheduled
            }
            spaces={spaces}
            allowOverview
            membersBySpace={membersBySpace}
            canAssignBySpace={canAssignBySpace}
            hideTitle
            mobileDateChrome
            viewRange={range === "all" ? "week" : range}
          />
        </div>
      ) : null}

      {tab === "list" ? (
        <TodoListPanel
          mobile={isMobile}
          todos={(isMobile ? boardsOpen.filter(isOwnTodo) : boardsOpen).filter(
            (t) => t.start_at,
          )}
          completed={(
            isMobile ? boardsDone.filter(isOwnTodo) : boardsDone
          ).filter((t) => t.start_at)}
          unscheduledTodos={
            isMobile ? filteredUnscheduled.filter(isOwnTodo) : filteredUnscheduled
          }
          hiddenCount={hiddenCount}
          onShowAll={onShowAll}
          members={flatMembers}
          canAssign={canAssignAny}
          hideTitle
          spaces={spaces}
          defaultSpaceId={spaces[0]?.id}
        />
      ) : null}
    </div>
  );
}
