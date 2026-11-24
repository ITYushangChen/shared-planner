/**
 * 资料板块：表格 / 看板的本地数据结构与序列化工具。
 *
 * 存储约定（与后端 docs.kind 配套）：
 *   kind='table' → docs.content 存 TableData 的 JSON
 *   kind='board' → docs.content 存 BoardData 的 JSON
 *
 * 解析一律走「宽松恢复」：内容损坏或格式不符时退化成默认空表，
 * 保证用户不会因为一次脏数据而彻底打不开文档。
 */

// ── 表格 ────────────────────────────────────────────────────────────────────

export type TableColumn = {
  id: string;
  name: string;
};

export type TableRow = {
  id: string;
  /** 列 id → 单元格文本；缺键按空串处理 */
  cells: Record<string, string>;
};

export type TableData = {
  version: 1;
  columns: TableColumn[];
  rows: TableRow[];
};

// ── 看板 ────────────────────────────────────────────────────────────────────

export type BoardCard = {
  id: string;
  text: string;
};

export type BoardColumn = {
  id: string;
  title: string;
  cards: BoardCard[];
};

export type BoardData = {
  version: 1;
  columns: BoardColumn[];
};

// ── 通用工具 ────────────────────────────────────────────────────────────────

let seq = 0;

/** 短 id：时间戳 36 进制 + 自增序号，足够区分同一次会话里的所有节点 */
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

// ── 表格：默认值 / 解析 / 序列化 ─────────────────────────────────────────────

const DEFAULT_TABLE_COLUMNS = ["事项", "负责人", "状态", "备注"];

export function emptyTable(): TableData {
  const columns: TableColumn[] = DEFAULT_TABLE_COLUMNS.map((name) => ({
    id: newId("col"),
    name,
  }));
  const rows: TableRow[] = Array.from({ length: 3 }, () => ({
    id: newId("row"),
    cells: Object.fromEntries(columns.map((c) => [c.id, ""])),
  }));
  return { version: 1, columns, rows };
}

export function parseTable(raw: string | null | undefined): TableData {
  const text = (raw ?? "").trim();
  if (!text) return emptyTable();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return emptyTable();
  }
  if (!obj || typeof obj !== "object") return emptyTable();
  const src = obj as { columns?: unknown; rows?: unknown };

  const columns: TableColumn[] = (Array.isArray(src.columns) ? src.columns : [])
    .map((c) => c as { id?: unknown; name?: unknown })
    .filter((c) => c && typeof c.id === "string" && c.id.length > 0)
    .map((c) => ({ id: c.id as string, name: str(c.name, "未命名列") }));

  if (columns.length === 0) return emptyTable();
  const colIds = columns.map((c) => c.id);

  const rows: TableRow[] = (Array.isArray(src.rows) ? src.rows : [])
    .map((r) => r as { id?: unknown; cells?: unknown })
    .filter((r) => r && typeof r.id === "string" && r.id.length > 0)
    .map((r) => {
      const rawCells =
        r.cells && typeof r.cells === "object"
          ? (r.cells as Record<string, unknown>)
          : {};
      const cells: Record<string, string> = {};
      for (const cid of colIds) cells[cid] = str(rawCells[cid]);
      return { id: r.id as string, cells };
    });

  return { version: 1, columns, rows };
}

export function serializeTable(table: TableData): string {
  return JSON.stringify(table);
}

/** CSV 转义：含逗号/引号/换行的值用双引号包裹，内部引号翻倍 */
function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** 表格导出 CSV（带 UTF-8 BOM，Excel 打开中文不乱码） */
export function tableToCsv(table: TableData): string {
  const header = table.columns.map((c) => csvCell(c.name)).join(",");
  const body = table.rows.map((r) =>
    table.columns.map((c) => csvCell(r.cells[c.id] ?? "")).join(","),
  );
  return [header, ...body].join("\r\n");
}

// ── 看板：默认值 / 解析 / 序列化 ─────────────────────────────────────────────

const DEFAULT_BOARD_COLUMNS = ["待办", "进行中", "已完成"];

export function emptyBoard(): BoardData {
  return {
    version: 1,
    columns: DEFAULT_BOARD_COLUMNS.map((title) => ({
      id: newId("bcol"),
      title,
      cards: [],
    })),
  };
}

export function parseBoard(raw: string | null | undefined): BoardData {
  const text = (raw ?? "").trim();
  if (!text) return emptyBoard();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return emptyBoard();
  }
  if (!obj || typeof obj !== "object") return emptyBoard();
  const src = obj as { columns?: unknown };

  const columns: BoardColumn[] = (Array.isArray(src.columns) ? src.columns : [])
    .map((c) => c as { id?: unknown; title?: unknown; cards?: unknown })
    .filter((c) => c && typeof c.id === "string" && c.id.length > 0)
    .map((c) => ({
      id: c.id as string,
      title: str(c.title, "未命名列"),
      cards: (Array.isArray(c.cards) ? c.cards : [])
        .map((k) => k as { id?: unknown; text?: unknown })
        .filter((k) => k && typeof k.id === "string" && k.id.length > 0)
        .map((k) => ({ id: k.id as string, text: str(k.text) })),
    }));

  if (columns.length === 0) return emptyBoard();
  return { version: 1, columns };
}

export function serializeBoard(board: BoardData): string {
  return JSON.stringify(board);
}
