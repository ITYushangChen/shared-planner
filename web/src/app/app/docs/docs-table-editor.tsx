"use client";

import {
  newId,
  type TableColumn,
  type TableData,
  type TableRow,
} from "./docs-types";

/**
 * 简单表格编辑器：受控组件，所有改动通过 onChange 回抛给资料页。
 * 不做虚拟滚动 —— 资料库表格是几十行的量级，直接渲染更简单也更少 bug。
 */
type Props = {
  value: TableData;
  onChange: (next: TableData) => void;
};

/** 单元格 / 表头输入框的共用样式：无边框、聚焦时给一点底色提示 */
const cellInputClass =
  "w-full bg-transparent px-2 py-1.5 text-sm text-[var(--brand-ink)] outline-none placeholder:text-[var(--text-muted)]/60";

export function DocsTableEditor({ value, onChange }: Props) {
  const { columns, rows } = value;

  // ── 列操作 ──
  function updateColumn(colId: string, name: string) {
    onChange({
      ...value,
      columns: columns.map((c) => (c.id === colId ? { ...c, name } : c)),
    });
  }

  function addColumn() {
    const col: TableColumn = {
      id: newId("col"),
      name: `列 ${columns.length + 1}`,
    };
    onChange({
      ...value,
      columns: [...columns, col],
      rows: rows.map((r) => ({
        ...r,
        cells: { ...r.cells, [col.id]: "" },
      })),
    });
  }

  function removeColumn(colId: string) {
    if (columns.length <= 1) {
      window.alert("至少保留一列");
      return;
    }
    const hasData = rows.some((r) => (r.cells[colId] ?? "").trim() !== "");
    if (hasData && !confirm("该列有内容，确定删除整列？此操作不可恢复。")) return;
    onChange({
      ...value,
      columns: columns.filter((c) => c.id !== colId),
      rows: rows.map((r) => {
        const cells = { ...r.cells };
        delete cells[colId];
        return { ...r, cells };
      }),
    });
  }

  // ── 行操作 ──
  function addRow() {
    const cells: Record<string, string> = {};
    for (const c of columns) cells[c.id] = "";
    const row: TableRow = { id: newId("row"), cells };
    onChange({ ...value, rows: [...rows, row] });
  }

  function removeRow(rowId: string) {
    const row = rows.find((r) => r.id === rowId);
    const hasData =
      row && columns.some((c) => (row.cells[c.id] ?? "").trim() !== "");
    if (hasData && !confirm("该行有内容，确定删除？此操作不可恢复。")) return;
    onChange({ ...value, rows: rows.filter((r) => r.id !== rowId) });
  }

  function updateCell(rowId: string, colId: string, text: string) {
    onChange({
      ...value,
      rows: rows.map((r) =>
        r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: text } } : r,
      ),
    });
  }

  return (
    <div className="mt-3">
      <div className="overflow-x-auto rounded-xl border border-[var(--border-muted)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[var(--surface-muted)]">
              <th className="w-9 p-0 text-center text-xs font-normal text-[var(--text-muted)]">
                #
              </th>
              {columns.map((c) => (
                <th
                  key={c.id}
                  className="min-w-[150px] border-l border-[var(--border-muted)] p-0 text-left"
                >
                  <div className="group flex items-center gap-1 pr-1">
                    <input
                      value={c.name}
                      onChange={(e) => updateColumn(c.id, e.target.value)}
                      placeholder="列名"
                      className={`${cellInputClass} font-medium`}
                    />
                    <button
                      type="button"
                      title="删除整列"
                      onClick={() => removeColumn(c.id)}
                      className="shrink-0 rounded-md px-1 text-xs text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                    >
                      ✕
                    </button>
                  </div>
                </th>
              ))}
              <th className="w-9 border-l border-[var(--border-muted)] p-0" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.id} className="focus-within:bg-[#f7fbff]">
                <td className="border-t border-[var(--border-muted)] p-0 text-center text-xs text-[var(--text-muted)]">
                  {idx + 1}
                </td>
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className="border-l border-t border-[var(--border-muted)] p-0"
                  >
                    <input
                      value={r.cells[c.id] ?? ""}
                      onChange={(e) => updateCell(r.id, c.id, e.target.value)}
                      className={cellInputClass}
                    />
                  </td>
                ))}
                <td className="border-l border-t border-[var(--border-muted)] p-0 text-center">
                  <button
                    type="button"
                    title="删除此行"
                    onClick={() => removeRow(r.id)}
                    className="rounded-md px-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addRow}
          className="rounded-lg border border-dashed border-[#2f5f8f]/40 px-3 py-1.5 text-xs font-medium text-[#2f5f8f] transition-colors hover:bg-[#e8f0f7]"
        >
          + 添加行
        </button>
        <button
          type="button"
          onClick={addColumn}
          className="rounded-lg border border-dashed border-[#2f5f8f]/40 px-3 py-1.5 text-xs font-medium text-[#2f5f8f] transition-colors hover:bg-[#e8f0f7]"
        >
          + 添加列
        </button>
        <span className="text-xs text-[var(--text-muted)]">
          {rows.length} 行 × {columns.length} 列
        </span>
      </div>
    </div>
  );
}
