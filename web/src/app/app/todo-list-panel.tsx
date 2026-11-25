"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { findConflictTodoIds } from "@/lib/conflicts";
import {
  PRIORITY_COLORS,
  PRIORITY_LABEL,
  formatTodoTimeLabel,
  sortByQuadrantOrderThenTime,
  type SpaceMemberOption,
  type SpaceNavItem,
  type TodoRow,
} from "@/lib/todos";
import { TodoEditor } from "./todo-editor";
import { QuickCreateTodo } from "./quick-create-todo";
import { Modal } from "./ui-modal";

type Props = {
  todos: TodoRow[];
  completed?: TodoRow[];
  /** 未排期（无 start_at）的待办，合并进同一张表 */
  unscheduledTodos?: TodoRow[];
  members: SpaceMemberOption[];
  title?: string;
  canAssign?: boolean;
  hideTitle?: boolean;
  spaces?: SpaceNavItem[];
  defaultSpaceId?: string;
  /** true：表格内同时展示已完成；false：仅未完成 */
  includeDone?: boolean;
  /** 当前时间范围外、或被指派给当前筛选人但未显示的待办数量（用于空态引导） */
  hiddenCount?: number;
  /** 点击"查看全部"时回调（切到 range=all） */
  onShowAll?: () => void;
  /** 手机端紧凑模式：隐藏「负责人」列、收窄留白、缩字号（桌面端不传） */
  mobile?: boolean;
};

function isOverdue(todo: TodoRow, now: number): boolean {
  if (todo.status === "done" || !todo.due_at) return false;
  const t = new Date(todo.due_at).getTime();
  return !Number.isNaN(t) && t < now;
}

function assigneeLabel(todo: TodoRow): { text: string; extra: number } {
  const list = todo.todo_assignees ?? [];
  if (list.length === 0) return { text: "未指派", extra: 0 };
  const first = list[0].profiles?.display_name || "未知";
  return { text: first, extra: Math.max(0, list.length - 1) };
}

export function TodoListPanel({
  todos,
  completed = [],
  unscheduledTodos = [],
  members,
  title = "待办列表",
  canAssign = false,
  hideTitle = false,
  spaces = [],
  defaultSpaceId,
  includeDone = false,
  hiddenCount = 0,
  onShowAll,
  mobile = false,
}: Props) {
  const supabase = createClient();
  const [selected, setSelected] = useState<TodoRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const now = Date.now();
  const conflictIds = useMemo(() => findConflictTodoIds(todos), [todos]);

  const rows = useMemo(() => {
    const open = [
      ...todos.filter((t) => t.status !== "done"),
      ...unscheduledTodos.filter((t) => t.status !== "done"),
    ];
    const all = includeDone
      ? [...open, ...completed.filter((t) => t.status === "done")]
      : open;
    return sortByQuadrantOrderThenTime(all);
  }, [todos, unscheduledTodos, completed, includeDone]);

  const createSpaceId = defaultSpaceId || spaces[0]?.id;
  const canCreate = spaces.length > 0;

  async function toggleDone(todo: TodoRow) {
    if (toggling === todo.id) return;
    setToggling(todo.id);
    const nextDone = todo.status !== "done";
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("todos")
      .update(
        nextDone
          ? {
              status: "done",
              completed_by: user?.id ?? null,
              completed_at: new Date().toISOString(),
            }
          : {
              status: "todo",
              completed_by: null,
              completed_at: null,
            },
      )
      .eq("id", todo.id);
    setToggling(null);
    if (error) alert(error.message);
  }

  // 手机端紧凑：更小留白 + 缩字号 + 取消最小宽（避免横向滚动遮挡）；桌面端保持原样
  const cellPad = mobile ? "px-1.5 py-1.5" : "px-2 py-2";
  const tableBase = mobile
    ? "w-full min-w-0 border-collapse text-left text-[11px]"
    : "w-full min-w-[640px] border-collapse text-left text-xs";

  return (
    <div className="flex flex-col gap-3">
      {hideTitle || canCreate ? (
        <div className="flex items-center justify-between gap-2">
          {hideTitle ? null : (
            <h2 className="text-sm font-medium text-zinc-800">{title}</h2>
          )}
          {canCreate ? (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-[var(--border-muted)] bg-white px-2.5 py-1 text-xs font-medium text-[var(--brand-ink)] transition-colors hover:border-[var(--brand)] hover:bg-[var(--brand-soft)]"
            >
              ＋ 新建待办
            </button>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-3 py-3 text-xs text-zinc-600">
          {hiddenCount > 0 && onShowAll ? (
            <span className="flex flex-wrap items-center gap-2">
              <span>
                该时间范围暂无未完成任务，你还有 {hiddenCount} 项任务排在其它的时间。
              </span>
              <button
                type="button"
                onClick={onShowAll}
                className="rounded-md border border-[var(--brand)] bg-[var(--brand-soft)] px-2 py-1 font-medium text-[var(--brand)] hover:bg-[var(--brand)] hover:text-white"
              >
                查看全部（不限时间）
              </button>
            </span>
          ) : (
            <span>该时间范围暂无未完成任务。</span>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border-muted)] bg-white">
          <table className={tableBase}>
            <thead>
              <tr className="border-b border-[var(--border-muted)] bg-[var(--surface-muted)]/60 text-[var(--text-muted)]">
                <th
                  className={`${mobile ? "w-8" : "w-10"} ${cellPad} text-center font-medium`}
                >
                  完成
                </th>
                <th className={`${cellPad} font-medium`}>标题</th>
                <th
                  className={`${mobile ? "w-14" : "w-16"} ${cellPad} whitespace-nowrap font-medium`}
                >
                  优先级
                </th>
                <th
                  className={`${mobile ? "w-28" : "w-44"} ${cellPad} whitespace-nowrap font-medium`}
                >
                  截止 / 时间
                </th>
                {!mobile ? (
                  <th className={`w-28 ${cellPad} font-medium`}>负责人</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const overdue = isOverdue(t, now);
                const { text: assignee, extra } = assigneeLabel(t);
                const conflicted = conflictIds.has(t.id);
                const done = t.status === "done";
                const accent = conflicted
                  ? "#e85d5d"
                  : PRIORITY_COLORS[t.priority] ?? "var(--text-muted)";
                return (
                  <tr
                    key={t.id}
                    onClick={() => setSelected(t)}
                    className={[
                      "cursor-pointer border-b border-zinc-100 transition-colors hover:bg-zinc-50",
                      done ? "opacity-60" : "",
                      conflicted ? "bg-red-50/40" : "",
                    ].join(" ")}
                  >
                    <td
                      className={`${cellPad} text-center`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        aria-label={done ? "标为未完成" : "标为完成"}
                        disabled={toggling === t.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleDone(t);
                        }}
                        className={[
                          "mx-auto flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors",
                          done
                            ? "border-zinc-900 bg-zinc-900 text-[10px] text-white"
                            : "border-zinc-300 bg-white hover:border-zinc-900",
                        ].join(" ")}
                      >
                        {done ? "✓" : null}
                      </button>
                    </td>
                    <td className={cellPad}>
                      <div className="flex min-w-0 items-center gap-1.5">
                        {conflicted ? (
                          <span className="shrink-0 rounded bg-red-100 px-1 text-[10px] font-medium text-red-600">
                            冲突
                          </span>
                        ) : null}
                        <span
                          className={[
                            "min-w-0 truncate font-medium",
                            done
                              ? "text-zinc-400 line-through"
                              : "text-zinc-900",
                          ].join(" ")}
                          title={t.title}
                        >
                          {t.title}
                        </span>
                      </div>
                    </td>
                    <td className={`${cellPad} whitespace-nowrap`}>
                      <span className="font-medium" style={{ color: accent }}>
                        {PRIORITY_LABEL[t.priority] ?? "—"}
                      </span>
                    </td>
                    <td className={cellPad}>
                      {overdue ? (
                        <span className="mr-1 rounded bg-red-100 px-1 text-[10px] font-medium text-red-600">
                          逾期
                        </span>
                      ) : null}
                      <span
                        className={[
                          mobile ? "whitespace-nowrap" : "",
                          "tabular-nums",
                          overdue
                            ? "font-medium text-red-600"
                            : "text-zinc-500",
                        ].join(" ")}
                        title={t.due_at ?? t.start_at ?? ""}
                      >
                        {formatTodoTimeLabel(t)}
                      </span>
                    </td>
                    {!mobile ? (
                      <td className={`${cellPad} text-zinc-600`}>
                        <span className="block truncate" title={assignee}>
                          {assignee}
                        </span>
                        {extra > 0 ? (
                          <span className="text-[10px] text-zinc-400">
                            +{extra}
                          </span>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <TodoEditor
          todo={selected}
          members={members}
          canAssign={canAssign}
          open
          onClose={() => setSelected(null)}
        />
      ) : null}

      {createOpen && createSpaceId ? (
        <Modal
          open
          onClose={() => setCreateOpen(false)}
          title="新建待办"
          zClass="z-[80]"
          overlayClassName="flex items-start justify-center overflow-y-auto p-4 pt-[8vh]"
          className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-4 shadow-xl"
        >
          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-900">新建待办</h2>
              <button
                type="button"
                className="rounded px-2 py-1 text-sm text-zinc-500"
                onClick={() => setCreateOpen(false)}
              >
                关闭
              </button>
            </div>
            <QuickCreateTodo
              key={`${createSpaceId}`}
              spaces={spaces}
              defaultSpaceId={createSpaceId}
              members={members}
              canAssign={canAssign}
              bare
              onCreated={() => setCreateOpen(false)}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
