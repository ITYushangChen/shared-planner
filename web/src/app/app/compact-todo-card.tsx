"use client";

import { useRef, useState, type DragEvent, type MouseEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { TODO_DND_MIME } from "@/lib/quadrant-dnd";
import {
  PRIORITY_LABEL,
  formatTodoTimeLabel,
  resolveTodoDurationMinutes,
  rruleLabel,
  type TodoRow,
} from "@/lib/todos";
import { resolveTodoColor } from "@/lib/ui-prefs";
import { useUiPrefsOptional } from "./ui-prefs-provider";

type Props = {
  todo: TodoRow;
  conflicted?: boolean;
  draggable?: boolean;
  importanceDrag?: boolean;
  onToggleImportance?: () => void;
  /** 作为拖拽落点：拖到该卡片上时回调，position 表示插入到卡片之前/之后 */
  onCardDrop?: (e: DragEvent, position: "before" | "after") => void;
  /** 左侧圆圈标记完成 */
  showComplete?: boolean;
  variant?: "list" | "card";
  layout?: "row" | "stack";
  onOpen?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  /** E2E 钩子：注入到根元素的 data-testid（如象限卡统一打 "quadrant-todo-card"） */
  testId?: string;
};

/** 当前正在被拖拽的任务 id（用于卡片不把自己当作落点） */
let DRAGGING_TODO_ID: string | null = null;

function subtitleLabel(todo: TodoRow): string {
  return formatTodoTimeLabel(todo);
}

export function CompactTodoCard({
  todo,
  conflicted,
  draggable = false,
  importanceDrag = false,
  onToggleImportance,
  onCardDrop,
  showComplete = false,
  variant = "list",
  layout = "row",
  onOpen,
  onContextMenu,
  testId,
}: Props) {
  const supabase = createClient();
  const dragMoved = useRef(false);
  const [toggling, setToggling] = useState(false);
  const [doneOptimistic, setDoneOptimistic] = useState<boolean | null>(null);
  const [dragEdge, setDragEdge] = useState<"top" | "bottom" | null>(null);
  const uiPrefs = useUiPrefsOptional()?.globalPrefs;
  const accent = conflicted
    ? "#e85d5d"
    : resolveTodoColor(todo.color, todo.priority, uiPrefs);
  const isDone =
    doneOptimistic !== null ? doneOptimistic : todo.status === "done";
  const timeLabel = subtitleLabel(todo);
  const importanceLabel = PRIORITY_LABEL[todo.priority] ?? "不重要";
  const durationMinutes = resolveTodoDurationMinutes(todo);
  const recurLabel = rruleLabel(todo.rrule);

  const isCard = variant === "card";
  const htmlDraggable = importanceDrag || draggable;

  async function toggleDone(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (toggling) return;
    setToggling(true);
    const nextDone = !isDone;
    setDoneOptimistic(nextDone);
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
    setToggling(false);
    if (error) {
      setDoneOptimistic(null);
      alert(error.message);
    }
  }

  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      draggable={htmlDraggable}
      className={[
        "group relative flex w-full items-start gap-2 text-left transition-colors duration-200",
        isCard
          ? "rounded-lg border border-zinc-200 bg-white px-2 py-1.5 hover:bg-zinc-50"
          : "border-b border-zinc-100 bg-white px-2 py-1.5 hover:bg-zinc-50",
        conflicted ? "border-red-200 bg-red-50/50" : "",
        draggable ? "fc-external-todo cursor-grab active:cursor-grabbing" : "",
        importanceDrag ? "cursor-grab active:cursor-grabbing" : "",
        onOpen && !htmlDraggable ? "cursor-pointer" : "",
        isDone ? "opacity-70" : "",
      ].join(" ")}
      onDragOver={(e) => {
        if (!onCardDrop) return;
        if (DRAGGING_TODO_ID === todo.id) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const pos: "top" | "bottom" =
          e.clientY - rect.top < rect.height / 2 ? "top" : "bottom";
        setDragEdge(pos);
      }}
      onDragLeave={(e) => {
        if (!onCardDrop) return;
        const related = e.relatedTarget as Node | null;
        if (related && e.currentTarget.contains(related)) return;
        setDragEdge(null);
      }}
      onDrop={(e) => {
        if (!onCardDrop) return;
        if (DRAGGING_TODO_ID === todo.id) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const position: "before" | "after" =
          e.clientY - rect.top < rect.height / 2 ? "before" : "after";
        setDragEdge(null);
        onCardDrop(e, position);
      }}
      data-id={todo.id}
      data-testid={testId}
      data-title={todo.title}
      data-duration={
        durationMinutes != null ? String(durationMinutes) : undefined
      }
      onDragStart={(e) => {
        if (!importanceDrag && !draggable) return;
        dragMoved.current = true;
        DRAGGING_TODO_ID = todo.id;
        e.dataTransfer.setData(TODO_DND_MIME, todo.id);
        e.dataTransfer.setData("text/plain", todo.id);
        e.dataTransfer.effectAllowed = "move";
        // 用卡片真实快照作拖影，让任务"跟着鼠标走"（而不是透明空白）
        const node = e.currentTarget as HTMLElement;
        const clone = node.cloneNode(true) as HTMLElement;
        Object.assign(clone.style, {
          position: "fixed",
          left: "-9999px",
          top: "-9999px",
          width: `${node.offsetWidth}px`,
          opacity: "0.92",
          pointerEvents: "none",
          transform: "rotate(1.5deg)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        });
        document.body.appendChild(clone);
        const rect = node.getBoundingClientRect();
        e.dataTransfer.setDragImage(
          clone,
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
        // 快照已在 setDragImage 时同步捕获，拖拽开始后移除克隆
        window.setTimeout(() => clone.remove(), 0);
      }}
      onDragEnd={() => {
        DRAGGING_TODO_ID = null;
        window.setTimeout(() => {
          dragMoved.current = false;
        }, 0);
      }}
      onClick={(e) => {
        if (!onOpen) return;
        if (dragMoved.current) return;
        const el = e.target as HTMLElement;
        if (el.closest("[data-importance-toggle],[data-complete-toggle]"))
          return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (!onOpen) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={onContextMenu}
    >
      {dragEdge === "top" ? (
        <span className="pointer-events-none absolute -top-[3px] left-1 right-1 z-20 h-[3px] rounded-full bg-[var(--brand)]" />
      ) : null}
      {dragEdge === "bottom" ? (
        <span className="pointer-events-none absolute -bottom-[3px] left-1 right-1 z-20 h-[3px] rounded-full bg-[var(--brand)]" />
      ) : null}
      {showComplete ? (
        <button
          type="button"
          data-complete-toggle
          aria-label={isDone ? "标为未完成" : "标为完成"}
          title={isDone ? "标为未完成" : "标为完成"}
          disabled={toggling}
          onClick={toggleDone}
          className={[
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
            isDone
              ? "border-zinc-900 bg-zinc-900 text-[10px] text-white"
              : "border-zinc-900 bg-white",
          ].join(" ")}
        >
          {isDone ? "✓" : null}
        </button>
      ) : null}

      <div className={["min-w-0 flex-1", layout === "stack" ? "" : ""].join(" ")}>
        <p
          className={[
            "truncate text-[12px] font-semibold leading-tight",
            isDone ? "text-zinc-400 line-through" : "text-zinc-900",
          ].join(" ")}
        >
          {todo.title}
          {recurLabel ? (
            <span className="ml-1 inline-flex items-center rounded bg-zinc-100 px-1 py-0.5 align-middle text-[9px] font-medium leading-none text-zinc-500">
              ⟳ {recurLabel}
            </span>
          ) : null}
          {conflicted ? (
            <span className="ml-1 text-[9px] font-medium text-red-600">
              冲突
            </span>
          ) : null}
        </p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-tight text-zinc-500">
          <span className="min-w-0 truncate tabular-nums" title={timeLabel}>
            {timeLabel}
          </span>
          <span className="shrink-0 text-zinc-300">·</span>
          {onToggleImportance ? (
            <button
              type="button"
              data-importance-toggle
              title="切换重要性"
              onClick={(e) => {
                e.stopPropagation();
                onToggleImportance();
              }}
              className="shrink-0 font-medium active:opacity-70"
              style={{ color: accent }}
            >
              {importanceLabel}
            </button>
          ) : (
            <span className="shrink-0 font-medium" style={{ color: accent }}>
              {importanceLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
