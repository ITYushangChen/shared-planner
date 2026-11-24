"use client";

import { useState, type DragEvent } from "react";
import {
  newId,
  type BoardColumn,
  type BoardData,
} from "./docs-types";

/**
 * 看板编辑器：列 + 卡片，支持鼠标拖拽跨列移动。
 * 拖拽之上还留了 ← / → 小按钮做兜底 —— 触屏设备 HTML5 拖拽不生效，
 * 这时候用按钮一样能挪卡片。
 */
type Props = {
  value: BoardData;
  onChange: (next: BoardData) => void;
};

type DragState = { cardId: string; fromColId: string };

export function DocsBoardEditor({ value, onChange }: Props) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [overColId, setOverColId] = useState<string | null>(null);

  const { columns } = value;

  function commit(nextColumns: BoardColumn[]) {
    onChange({ ...value, columns: nextColumns });
  }

  // ── 列操作 ──
  function updateColumnTitle(colId: string, title: string) {
    commit(columns.map((c) => (c.id === colId ? { ...c, title } : c)));
  }

  function addColumn() {
    commit([
      ...columns,
      { id: newId("bcol"), title: `列 ${columns.length + 1}`, cards: [] },
    ]);
  }

  function removeColumn(colId: string) {
    if (columns.length <= 1) {
      window.alert("至少保留一列");
      return;
    }
    const col = columns.find((c) => c.id === colId);
    if (col && col.cards.length > 0) {
      if (!confirm(`「${col.title}」里有 ${col.cards.length} 张卡片，确定整列删除？`))
        return;
    }
    commit(columns.filter((c) => c.id !== colId));
  }

  // ── 卡片操作 ──
  function addCard(colId: string) {
    commit(
      columns.map((c) =>
        c.id === colId
          ? { ...c, cards: [...c.cards, { id: newId("card"), text: "" }] }
          : c,
      ),
    );
  }

  function updateCardText(colId: string, cardId: string, text: string) {
    commit(
      columns.map((c) =>
        c.id === colId
          ? {
              ...c,
              cards: c.cards.map((k) => (k.id === cardId ? { ...k, text } : k)),
            }
          : c,
      ),
    );
  }

  function removeCard(colId: string, cardId: string) {
    const col = columns.find((c) => c.id === colId);
    const card = col?.cards.find((k) => k.id === cardId);
    if (card && card.text.trim() && !confirm("确定删除这张卡片？")) return;
    commit(
      columns.map((c) =>
        c.id === colId
          ? { ...c, cards: c.cards.filter((k) => k.id !== cardId) }
          : c,
      ),
    );
  }

  /** 把卡片从来源列移到目标列末尾；同列时原地不动 */
  function moveCard(cardId: string, fromColId: string, toColId: string) {
    if (fromColId === toColId) return;
    const from = columns.find((c) => c.id === fromColId);
    const card = from?.cards.find((k) => k.id === cardId);
    if (!card) return;
    commit(
      columns.map((c) => {
        if (c.id === fromColId) {
          return { ...c, cards: c.cards.filter((k) => k.id !== cardId) };
        }
        if (c.id === toColId) {
          return { ...c, cards: [...c.cards, card] };
        }
        return c;
      }),
    );
  }

  /** ← / → 按列顺序挪一格，到边界就停住（按钮本身也置灰） */
  function moveCardBy(colId: string, cardId: string, delta: -1 | 1) {
    const idx = columns.findIndex((c) => c.id === colId);
    const target = columns[idx + delta];
    if (!target) return;
    moveCard(cardId, colId, target.id);
  }

  // ── 拖拽 ──
  function onCardDragStart(e: DragEvent<HTMLDivElement>, colId: string, cardId: string) {
    setDrag({ cardId, fromColId: colId });
    e.dataTransfer.effectAllowed = "move";
    // Firefox 必须写点数据，否则拖拽不会启动
    e.dataTransfer.setData("text/plain", cardId);
  }

  function onColumnDragOver(e: DragEvent<HTMLDivElement>, colId: string) {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overColId !== colId) setOverColId(colId);
  }

  function onColumnDrop(e: DragEvent<HTMLDivElement>, colId: string) {
    e.preventDefault();
    if (drag) moveCard(drag.cardId, drag.fromColId, colId);
    setDrag(null);
    setOverColId(null);
  }

  return (
    <div className="mt-3">
      <div className="flex items-start gap-3 overflow-x-auto pb-2">
        {columns.map((col, colIdx) => (
          <div
            key={col.id}
            onDragOver={(e) => onColumnDragOver(e, col.id)}
            onDragLeave={() => setOverColId((v) => (v === col.id ? null : v))}
            onDrop={(e) => onColumnDrop(e, col.id)}
            className={[
              "flex w-[260px] shrink-0 flex-col rounded-xl border bg-[var(--surface-muted)] p-2",
              "transition-colors duration-200",
              overColId === col.id && drag
                ? "border-[#185FA5] bg-[#e8f0f7]"
                : "border-[var(--border-muted)]",
            ].join(" ")}
          >
            {/* 列头 */}
            <div className="group flex items-center gap-1">
              <input
                value={col.title}
                onChange={(e) => updateColumnTitle(col.id, e.target.value)}
                placeholder="列名称"
                className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm font-semibold text-[var(--brand-ink)] outline-none focus:bg-white"
              />
              <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
                {col.cards.length}
              </span>
              <button
                type="button"
                title="删除整列"
                onClick={() => removeColumn(col.id)}
                className="shrink-0 rounded-md px-1 text-xs text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
              >
                ✕
              </button>
            </div>

            {/* 卡片列表 */}
            <div className="mt-2 flex min-h-[60px] flex-col gap-2">
              {col.cards.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[var(--border-muted)] px-2 py-3 text-center text-[11px] text-[var(--text-muted)]">
                  {drag ? "拖到这里" : "还没有卡片"}
                </p>
              ) : null}

              {col.cards.map((card) => (
                <div
                  key={card.id}
                  draggable
                  onDragStart={(e) => onCardDragStart(e, col.id, card.id)}
                  onDragEnd={() => {
                    setDrag(null);
                    setOverColId(null);
                  }}
                  className={[
                    "group cursor-grab rounded-lg border border-[var(--border-muted)] bg-white p-1.5",
                    "transition-shadow duration-200 hover:shadow-sm active:cursor-grabbing",
                    drag?.cardId === card.id ? "opacity-50" : "",
                  ].join(" ")}
                >
                  <input
                    value={card.text}
                    onChange={(e) =>
                      updateCardText(col.id, card.id, e.target.value)
                    }
                    placeholder="卡片内容"
                    onMouseDown={(e) => e.stopPropagation()}
                    className="w-full cursor-text rounded-md bg-transparent px-1 py-0.5 text-sm text-[var(--brand-ink)] outline-none placeholder:text-[var(--text-muted)]/60 focus:bg-[var(--surface-muted)]"
                  />
                  <div className="mt-1 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      title="移到左一列"
                      onClick={() => moveCardBy(col.id, card.id, -1)}
                      disabled={colIdx === 0}
                      className="rounded px-1 text-xs text-[var(--text-muted)] hover:bg-[#e8f0f7] hover:text-[#2f5f8f] disabled:opacity-30"
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      title="移到右一列"
                      onClick={() => moveCardBy(col.id, card.id, 1)}
                      disabled={colIdx === columns.length - 1}
                      className="rounded px-1 text-xs text-[var(--text-muted)] hover:bg-[#e8f0f7] hover:text-[#2f5f8f] disabled:opacity-30"
                    >
                      →
                    </button>
                    <button
                      type="button"
                      title="删除卡片"
                      onClick={() => removeCard(col.id, card.id)}
                      className="rounded px-1 text-xs text-[var(--text-muted)] hover:bg-red-50 hover:text-red-600"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => addCard(col.id)}
              className="mt-2 rounded-lg border border-dashed border-[#2f5f8f]/40 px-2 py-1.5 text-xs font-medium text-[#2f5f8f] transition-colors hover:bg-white"
            >
              + 添加卡片
            </button>
          </div>
        ))}

        {/* 添加列 */}
        <button
          type="button"
          onClick={addColumn}
          className="w-[160px] shrink-0 rounded-xl border border-dashed border-[#2f5f8f]/40 px-3 py-3 text-sm font-medium text-[#2f5f8f] transition-colors hover:bg-[#e8f0f7]"
        >
          + 添加列
        </button>
      </div>

      <p className="mt-1 text-xs text-[var(--text-muted)]">
        卡片可以拖动到其他列；触屏设备请用卡片右上角的 ← → 按钮。
      </p>
    </div>
  );
}
