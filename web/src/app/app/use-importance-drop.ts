"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react";
import { createClient } from "@/lib/supabase/client";
import {
  TODO_DND_MIME,
  quadrantToImportance,
} from "@/lib/quadrant-dnd";
import {
  importanceToPriority,
  todoImportance,
  type QuadrantKey,
  type TodoRow,
} from "@/lib/todos";
import { emitTodoUpserted } from "@/lib/todo-schedule-events";

type Options = {
  /** 未排期拖入象限时回调（打开编辑并提示设时间） */
  onUnscheduledDrop?: (todo: TodoRow, quadrantKey: string) => void;
};

type DropUpdate = {
  id: string;
  manual_quadrant?: QuadrantKey | null;
  priority?: "high" | "low";
  quadrant_order?: number | null;
};

/**
 * 四象限自由拖拽：
 * - 拖到任意象限：写 manual_quadrant（锁定位置）+ 同步重要性到 priority；
 * - 列内/跨列重排：按落点 before/after 重排 quadrant_order，受影响兄弟批量更新。
 */
export function useImportanceDrop(todoLists: TodoRow[][], options: Options = {}) {
  const { onUnscheduledDrop } = options;
  const supabase = createClient();
  const [overrides, setOverrides] = useState<
    Record<string, TodoRow["priority"]>
  >({});
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dropError, setDropError] = useState("");

  useEffect(() => {
    setOverrides((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const list of todoLists) {
        for (const t of list) {
          if (next[t.id] && next[t.id] === t.priority) {
            delete next[t.id];
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [todoLists]);

  const applyPriority = useCallback(
    (list: TodoRow[]) =>
      list.map((t) =>
        overrides[t.id] ? { ...t, priority: overrides[t.id] } : t,
      ),
    [overrides],
  );

  const findTodo = useCallback(
    (todoId: string): TodoRow | undefined => {
      for (const list of todoLists) {
        const found = list.find((t) => t.id === todoId);
        if (found) return found;
      }
      return undefined;
    },
    [todoLists],
  );

  const readDraggedId = useCallback((e: DragEvent): string => {
    return (
      e.dataTransfer.getData(TODO_DND_MIME) ||
      e.dataTransfer.getData("text/plain")
    );
  }, []);

  const onDragOverQuadrant = useCallback((e: DragEvent, key: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverKey(key);
  }, []);

  const onDragLeaveQuadrant = useCallback((e: DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOverKey(null);
  }, []);

  const moveTodoToQuadrant = useCallback(
    async (
      todoId: string,
      toQuadrant: QuadrantKey,
      orderedIds: string[],
      anchorCardId: string | null,
      anchorPos: "before" | "after" | null,
    ) => {
      const current = findTodo(todoId);
      if (!current) return;

      // 计算目标象限的新顺序
      const without = orderedIds.filter((id) => id !== todoId);
      let insertIdx = without.length; // 默认追加到末尾
      if (anchorCardId) {
        const idx = without.indexOf(anchorCardId);
        if (idx >= 0) insertIdx = anchorPos === "after" ? idx + 1 : idx;
      }
      const newOrder = [
        ...without.slice(0, insertIdx),
        todoId,
        ...without.slice(insertIdx),
      ];
      const orderMap = new Map<string, number>();
      newOrder.forEach((id, i) => orderMap.set(id, i + 1));

      const importance = quadrantToImportance(toQuadrant);
      const nextPriority = importanceToPriority(importance);
      const movedOrder = orderMap.get(todoId)!;

      const updates: DropUpdate[] = [];
      if (
        current.manual_quadrant !== toQuadrant ||
        todoImportance(current.priority) !== importance ||
        current.quadrant_order !== movedOrder
      ) {
        updates.push({
          id: todoId,
          manual_quadrant: toQuadrant,
          priority: nextPriority,
          quadrant_order: movedOrder,
        });
      }
      for (const id of newOrder) {
        if (id === todoId) continue;
        const t = findTodo(id);
        const newO = orderMap.get(id)!;
        if (t && t.quadrant_order !== newO) {
          updates.push({ id, quadrant_order: newO });
        }
      }

      if (updates.length === 0) return;

      // —— 乐观更新：拖完立刻本地重排，不等 realtime 回波、无需手动刷新 ——
      // 复用与日历/列表相同的 TODO_UPSERTED 通道，父级 onUpsert 会把带新
      // manual_quadrant/quadrant_order/priority 的行 merge 进源数据，四象限即时重绘。
      const originals = new Map<string, Partial<TodoRow>>();
      for (const id of newOrder) {
        const t = findTodo(id);
        if (!t) continue;
        const order = orderMap.get(id)!;
        const isMoved = id === todoId;
        originals.set(id, {
          manual_quadrant: t.manual_quadrant,
          priority: t.priority,
          quadrant_order: t.quadrant_order,
        });
        const merged: TodoRow = isMoved
          ? {
              ...t,
              manual_quadrant: toQuadrant,
              priority: nextPriority,
              quadrant_order: order,
            }
          : { ...t, quadrant_order: order };
        emitTodoUpserted(merged);
      }

      setDropError("");
      const results = await Promise.all(
        updates.map((u) =>
          supabase
            .from("todos")
            .update({
              ...(u.manual_quadrant !== undefined
                ? { manual_quadrant: u.manual_quadrant }
                : {}),
              ...(u.priority !== undefined ? { priority: u.priority } : {}),
              ...(u.quadrant_order !== undefined
                ? { quadrant_order: u.quadrant_order }
                : {}),
            })
            .eq("id", u.id),
        ),
      );
      const firstErr = results.find((r) => r.error)?.error;
      if (firstErr) {
        // 写库失败则回滚本地乐观更新，保留上次一致状态
        for (const [id, orig] of originals) {
          const t = findTodo(id);
          if (t) emitTodoUpserted({ ...t, ...orig });
        }
        setDropError(firstErr.message);
      }
    },
    [findTodo, supabase],
  );

  const onDropQuadrant = useCallback(
    async (e: DragEvent, quadrantKey: QuadrantKey, orderedIds: string[] = []) => {
      e.preventDefault();
      setDragOverKey(null);
      const todoId = readDraggedId(e);
      if (!todoId) return;
      await moveTodoToQuadrant(todoId, quadrantKey, orderedIds, null, null);
    },
    [readDraggedId, moveTodoToQuadrant],
  );

  const onDropOnCard = useCallback(
    async (
      e: DragEvent,
      quadrantKey: QuadrantKey,
      orderedIds: string[],
      anchorCardId: string,
      anchorPos: "before" | "after",
    ) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverKey(null);
      const todoId = readDraggedId(e);
      if (!todoId || todoId === anchorCardId) return;
      await moveTodoToQuadrant(
        todoId,
        quadrantKey,
        orderedIds,
        anchorCardId,
        anchorPos,
      );
    },
    [readDraggedId, moveTodoToQuadrant],
  );

  const setTodoImportance = useCallback(
    async (todo: TodoRow, importance: "important" | "normal") => {
      const effective = overrides[todo.id]
        ? { ...todo, priority: overrides[todo.id] }
        : todo;
      if (todoImportance(effective.priority) === importance) return;

      const nextPriority = importanceToPriority(importance);
      setOverrides((prev) => ({ ...prev, [todo.id]: nextPriority }));
      setDropError("");

      const { error } = await supabase
        .from("todos")
        .update({ priority: nextPriority, manual_quadrant: null })
        .eq("id", todo.id);

      if (error) {
        setOverrides((prev) => {
          const n = { ...prev };
          delete n[todo.id];
          return n;
        });
        setDropError(error.message);
        return;
      }
    },
    [overrides, supabase],
  );

  const toggleImportance = useCallback(
    async (todo: TodoRow) => {
      const effective = overrides[todo.id]
        ? { ...todo, priority: overrides[todo.id] }
        : todo;
      const next: "important" | "normal" =
        todoImportance(effective.priority) === "important"
          ? "normal"
          : "important";
      await setTodoImportance(todo, next);
    },
    [setTodoImportance],
  );

  return useMemo(
    () => ({
      applyPriority,
      dragOverKey,
      dropError,
      onDragOverQuadrant,
      onDragLeaveQuadrant,
      onDropQuadrant,
      onDropOnCard,
      moveTodoToQuadrant,
      setTodoImportance,
      toggleImportance,
    }),
    [
      applyPriority,
      dragOverKey,
      dropError,
      onDragOverQuadrant,
      onDragLeaveQuadrant,
      onDropQuadrant,
      onDropOnCard,
      moveTodoToQuadrant,
      setTodoImportance,
      toggleImportance,
    ],
  );
}
