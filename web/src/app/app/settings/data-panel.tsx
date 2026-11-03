"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { SpaceNavItem } from "@/lib/todos";
import { primaryBtnClass } from "../ui-btn-class";
import { DeleteAccountPanel } from "./delete-account-panel";
import {
  SettingsRow,
  SettingsSection,
  SettingsToggle,
  fieldClass,
} from "./settings-ui";

const EXPORT_LIMIT = 5000;

/** 导出列定义（CSV / Excel 共用同一套顺序与表头） */
const COLUMNS: { header: string; key: string }[] = [
  { header: "任务ID", key: "id" },
  { header: "空间", key: "space" },
  { header: "标题", key: "title" },
  { header: "描述", key: "description" },
  { header: "优先级", key: "priorityText" },
  { header: "状态", key: "statusText" },
  { header: "开始时间", key: "startAt" },
  { header: "结束时间", key: "endAt" },
  { header: "全天", key: "isAllDay" },
  { header: "截止时间", key: "dueAt" },
  { header: "完成时间", key: "completedAt" },
  { header: "创建时间", key: "createdAt" },
  { header: "指派人", key: "assignees" },
  { header: "未排期", key: "backlog" },
];

const STATUS_TEXT: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  done: "已完成",
};

const PRIORITY_TEXT: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

type AssigneeRow = {
  user_id: string;
  profiles?: { display_name: string | null } | null;
};

type TodoRow = {
  id: string;
  space_id: string;
  title: string;
  description: string | null;
  priority: string | null;
  status: string;
  start_at: string | null;
  end_at: string | null;
  is_all_day: boolean;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  todo_assignees?: AssigneeRow[] | null;
};

type ExportRow = Record<string, string | boolean>;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 指派给人名，拼成「张三、李四」，无人则「未指派」 */
function assigneeText(r: TodoRow): string {
  const names = (r.todo_assignees ?? [])
    .map((a) => a.profiles?.display_name?.trim() || "")
    .filter(Boolean);
  return names.length > 0 ? names.join("、") : "未指派";
}

/** 未排期 = 未完成且没有开始时间，与报告页 splitBacklogTodos 口径一致 */
function isBacklog(r: TodoRow): boolean {
  return r.status !== "done" && !r.start_at;
}

/** 把一行数据库记录摊平成导出行 */
function toExportRow(r: TodoRow, spaceName: (id: string) => string): ExportRow {
  return {
    id: r.id,
    space: spaceName(r.space_id),
    title: r.title,
    description: r.description ?? "",
    priorityText: PRIORITY_TEXT[r.priority ?? ""] ?? r.priority ?? "",
    statusText: STATUS_TEXT[r.status] ?? r.status,
    startAt: fmtTime(r.start_at),
    endAt: fmtTime(r.end_at),
    isAllDay: r.is_all_day ? "是" : "否",
    dueAt: fmtTime(r.due_at),
    completedAt: fmtTime(r.completed_at),
    createdAt: fmtTime(r.created_at),
    assignees: assigneeText(r),
    backlog: isBacklog(r) ? "是" : "否",
  };
}

/** CSV 单元格：含逗号/引号/换行才加引号，内部引号翻倍；以 = + - @ 开头的前缀单引号，防 CSV 公式注入 */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 带 BOM 的文本下载（CSV / 旧 JSON 用，保证 Excel 正确识别中文） */
function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: mime });
  downloadBlob(filename, blob);
}

/** 通用 Blob 下载（xlsx 等二进制不要 BOM） */
function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延迟回收：立即 revoke 会让部分浏览器/自动化在读完 blob 前取消下载
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 按内容估算 Excel 列宽（中文算 2 宽），上限 50 */
function colWidth(values: string[]): number {
  let max = 8;
  for (const v of values) {
    let len = 0;
    for (const ch of String(v)) len += ch.charCodeAt(0) > 255 ? 2 : 1;
    if (len > max) max = len;
  }
  return Math.min(max + 2, 50);
}

export function DataPanel({ spaces }: { spaces: SpaceNavItem[] }) {
  const supabase = createClient();
  const [spaceId, setSpaceId] = useState<string>("all");
  const [format, setFormat] = useState<"csv" | "json" | "xlsx">("xlsx");
  const [includeDone, setIncludeDone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const spaceName = (id: string) =>
    spaces.find((s) => s.id === id)?.name ?? "未知空间";

  async function onExport() {
    setBusy(true);
    setMsg("正在读取数据…");

    let q = supabase
      .from("todos")
      .select(
        "id, space_id, title, description, priority, status, start_at, end_at, is_all_day, due_at, completed_at, created_at, todo_assignees(user_id, profiles(display_name))",
      )
      .order("created_at", { ascending: false })
      .limit(EXPORT_LIMIT);

    // 限定在自己有权限的空间内，避免只靠 RLS 兜底
    const myIds = spaces.map((s) => s.id);
    if (spaceId === "all") {
      if (myIds.length > 0) q = q.in("space_id", myIds);
    } else {
      q = q.eq("space_id", spaceId);
    }
    if (!includeDone) q = q.neq("status", "done");

    const { data, error } = await q;
    setBusy(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    const rows = (data as TodoRow[] | null) ?? [];
    if (rows.length === 0) {
      setMsg("没有符合条件的数据");
      return;
    }

    const exportRows = rows.map((r) => toExportRow(r, spaceName));
    const fileSpace = spaceId === "all" ? "全部空间" : spaceName(spaceId);
    const base = `shared-planner-${fileSpace}-${stamp()}`;

    if (format === "xlsx") {
      await exportXlsx(base, exportRows, setMsg);
      setMsg(`已导出 ${rows.length} 条任务`);
      return;
    }

    if (format === "json") {
      const payload = rows.map((r) => ({
        id: r.id,
        space: spaceName(r.space_id),
        title: r.title,
        description: r.description,
        priority: r.priority,
        priorityText: PRIORITY_TEXT[r.priority ?? ""] ?? r.priority,
        status: r.status,
        statusText: STATUS_TEXT[r.status] ?? r.status,
        startAt: r.start_at,
        endAt: r.end_at,
        isAllDay: r.is_all_day,
        dueAt: r.due_at,
        completedAt: r.completed_at,
        createdAt: r.created_at,
        assignees: assigneeText(r),
        isBacklog: isBacklog(r),
      }));
      downloadText(
        `${base}.json`,
        JSON.stringify(
          { exportedAt: new Date().toISOString(), space: fileSpace, count: rows.length, todos: payload },
          null,
          2,
        ),
        "application/json;charset=utf-8",
      );
      setMsg(`已导出 ${rows.length} 条任务`);
      return;
    }

    // CSV
    const lines = [COLUMNS.map((c) => c.header).join(",")];
    for (const er of exportRows) {
      lines.push(
        COLUMNS.map((c) => csvCell(er[c.key])).join(","),
      );
    }
    downloadText(`${base}.csv`, lines.join("\r\n"), "text/csv;charset=utf-8");
    setMsg(`已导出 ${rows.length} 条任务`);
  }

  return (
    <div>
      <SettingsSection
        title="导出任务数据"
        desc={`导出你有权查看的待办，最多 ${EXPORT_LIMIT} 条；Excel(.xlsx) 带表头样式与筛选，CSV 也可直接用 Excel 打开。导入功能暂未开放。`}
      >
        <SettingsRow label="范围" hint="默认导出全部空间">
          <select
            className={fieldClass()}
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
            disabled={busy}
          >
            <option value="all">全部空间</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </SettingsRow>

        <SettingsRow label="格式" hint="Excel 带样式与筛选，CSV 兼容性好，JSON 适合程序处理">
          <select
            className={fieldClass()}
            value={format}
            onChange={(e) => setFormat(e.target.value as "csv" | "json" | "xlsx")}
            disabled={busy}
          >
            <option value="xlsx">Excel（.xlsx，带样式/筛选）</option>
            <option value="csv">CSV（Excel 可直接打开）</option>
            <option value="json">JSON（含完整字段）</option>
          </select>
        </SettingsRow>

        <SettingsRow label="包含已完成" hint="关闭则只导出未完成的任务">
          <SettingsToggle
            label="包含已完成"
            checked={includeDone}
            onChange={setIncludeDone}
            disabled={busy}
          />
        </SettingsRow>

        <SettingsRow
          label="生成文件"
          hint={msg || "点击后会在浏览器里下载一个文件"}
        >
          <button
            type="button"
            onClick={() => void onExport()}
            disabled={busy}
            className={`${primaryBtnClass()} disabled:opacity-40`}
          >
            {busy ? "导出中…" : "导出"}
          </button>
        </SettingsRow>
      </SettingsSection>

      <DeleteAccountPanel />
    </div>
  );
}

/** 用 ExcelJS 生成真实 .xlsx：表头加粗+底色、冻结首行、自动列宽、开启筛选 */
async function exportXlsx(
  base: string,
  rows: ExportRow[],
  setMsg: (s: string) => void,
) {
  setMsg("正在生成 Excel…");
  // 仅在导出时才加载 ExcelJS，不拖慢设置页首屏
  const mod = await import("exceljs");
  const ExcelJS: typeof import("exceljs") = (mod as unknown as { default?: typeof import("exceljs") }).default ?? (mod as typeof import("exceljs"));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SharedPlanner";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("任务");

  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key }));

  for (const r of rows) sheet.addRow(r);

  // 表头样式：白字 + 深蓝底 + 居中加粗
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2F5F8F" },
  };
  headerRow.height = 22;

  // 冻结首行
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  // 自动列宽（按内容估算）
  for (let i = 1; i <= COLUMNS.length; i++) {
    const key = COLUMNS[i - 1].key;
    const values = rows.map((r) => String(r[key] ?? ""));
    sheet.getColumn(i).width = colWidth(values);
  }

  // 开启筛选器（覆盖表头与所有数据行）
  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: COLUMNS.length },
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    `${base}.xlsx`,
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
}
