"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import {
  createDoc,
  deleteAttachment,
  deleteDoc,
  getDoc,
  listAttachments,
  listDocs,
  registerAttachment,
  updateDoc,
  AiApiError,
  type Attachment,
  type DocKind,
  type DocMeta,
} from "@/lib/ai-api";
import { createClient } from "@/lib/supabase/client";
import type { SpaceNavItem } from "@/lib/todos";
import { primaryBtnClass, secondaryBtnClass } from "../ui-btn-class";
import { DocsBoardEditor } from "./docs-board-editor";
import { DocsTableEditor } from "./docs-table-editor";
import {
  emptyBoard,
  emptyTable,
  parseBoard,
  parseTable,
  serializeBoard,
  serializeTable,
  tableToCsv,
  type BoardData,
  type TableData,
} from "./docs-types";
import {
  downloadBlob,
  downloadDocx,
  downloadMarkdown,
  downloadPdf,
} from "./docs-export";

/** 附件单文件上限：与 storage library 桶 file_size_limit 一致（50MB） */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** 把字节数格式化成可读文本 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 三种资料类型的中文名与徽标配色 */
const KIND_META: Record<DocKind, { label: string; cls: string }> = {
  doc: { label: "文档", cls: "bg-[#e8f0f7] text-[#2f5f8f]" },
  table: { label: "表格", cls: "bg-[#e9f5ec] text-[#2f7d47]" },
  board: { label: "看板", cls: "bg-[#f5efe6] text-[#8a6a34]" },
};

/** 新建时的默认标题 */
const KIND_DEFAULT_TITLE: Record<DocKind, string> = {
  doc: "未命名文档",
  table: "未命名表格",
  board: "未命名看板",
};

type Props = {
  spaces: SpaceNavItem[];
};

function errText(e: unknown): string {
  if (e instanceof AiApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "未知错误";
}

/** 编辑器扩展：模块级常量，避免每次渲染重建 editor */
const editorExtensions = [
  StarterKit,
  Link.configure({ openOnClick: false }),
  Placeholder.configure({
    placeholder: "输入正文… 支持标题、列表、引用、代码等",
  }),
  Markdown,
];

/** 工具栏按钮（激活态用品牌色，照抄 chipClass 配色） */
function TbBtn(props: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className={[
        "flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-sm",
        "transition-colors duration-200",
        props.mono ? "font-mono text-[13px]" : "",
        props.active
          ? "bg-[#185FA5] text-white"
          : "text-[var(--brand-ink)] hover:bg-white",
        props.disabled ? "opacity-40" : "",
      ].join(" ")}
    >
      {props.children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="mx-1 h-5 w-px bg-[var(--border-muted)]" />;
}

export function DocsWorkspace({ spaces }: Props) {
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [kind, setKind] = useState<DocKind>("doc");
  const [title, setTitle] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState<"md" | "docx" | "pdf" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  /** 表格 / 看板有未落库改动时置 true（Markdown 区不跟踪，保持原行为） */
  const [dirty, setDirty] = useState(false);
  const [table, setTable] = useState<TableData>(emptyTable);
  const [board, setBoard] = useState<BoardData>(emptyBoard);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: editorExtensions,
    content: "",
    contentType: "markdown",
    immediatelyRender: false,
  });

  // 保存成功提示 2 秒后消失
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  // 切换空间时重新拉取该空间的文档列表，并清空当前选中
  useEffect(() => {
    setEditing(false);
    setSelectedDocId(null);
    setTitle("");
    setKind("doc");
    setTable(emptyTable());
    setBoard(emptyBoard());
    setDirty(false);
    editor?.commands.clearContent();

    if (!spaceId) {
      setDocs([]);
      return;
    }
    let cancelled = false;
    setDocsLoading(true);
    setError(null);
    void listDocs(spaceId)
      .then(({ docs: list }) => {
        if (!cancelled) setDocs(list);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      })
      .finally(() => {
        if (!cancelled) setDocsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, editor]);

  // 切换空间或选中文档时，拉取对应附件（选中文档→本篇附件；未选中→空间级附件）
  useEffect(() => {
    if (!spaceId) {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    setAttachmentsLoading(true);
    void listAttachments(spaceId)
      .then(({ attachments: list }) => {
        if (cancelled) return;
        setAttachments(
          selectedDocId
            ? list.filter((a) => a.doc_id === selectedDocId)
            : list.filter((a) => a.doc_id === null),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      })
      .finally(() => {
        if (!cancelled) setAttachmentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, selectedDocId]);

  async function refreshDocs() {
    const { docs: list } = await listDocs(spaceId);
    setDocs(list);
  }

  async function refreshAttachments() {
    const { attachments: list } = await listAttachments(spaceId);
    setAttachments(
      selectedDocId
        ? list.filter((a) => a.doc_id === selectedDocId)
        : list.filter((a) => a.doc_id === null),
    );
  }

  async function handleUploadFile(file: File | null) {
    if (!file) return;
    if (!spaceId) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError("文件需小于 50MB");
      return;
    }
    setUploading(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setUploading(false);
      setError("请先登录");
      return;
    }
    // 路径第一段必须是上传人 uid（storage 策略要求），再加空间 + 时间戳避免同名覆盖
    const safeName = file.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
    const bucketPath = `${user.id}/${spaceId}/${Date.now()}-${safeName}`;
    const { error: upErr } = await supabase.storage
      .from("library")
      .upload(bucketPath, file, { upsert: false, contentType: file.type });
    if (upErr) {
      setUploading(false);
      setError(
        upErr.message.includes("Bucket not found")
          ? "未找到 library 存储桶，请先执行 storage 迁移 SQL"
          : upErr.message,
      );
      return;
    }
    try {
      await registerAttachment({
        space_id: spaceId,
        doc_id: selectedDocId ?? null,
        bucket_path: bucketPath,
        name: file.name,
        size: file.size,
        mime_type: file.type,
      });
      await refreshAttachments();
    } catch (e) {
      setError(errText(e));
    } finally {
      setUploading(false);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleDeleteAttachment(id: string) {
    if (!confirm("确定删除该附件？删除后不可恢复。")) return;
    setError(null);
    try {
      await deleteAttachment(id);
      await refreshAttachments();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function handleSelectDoc(docId: string) {
    setSelectedDocId(docId);
    setEditing(true);
    setDocLoading(true);
    setDirty(false);
    setError(null);
    try {
      const { doc: full } = await getDoc(docId);
      const docKind: DocKind = full.kind ?? "doc";
      setKind(docKind);
      setTitle(full.title);
      if (docKind === "table") {
        setTable(parseTable(full.content));
      } else if (docKind === "board") {
        setBoard(parseBoard(full.content));
      } else {
        editor?.commands.setContent(full.content ?? "", {
          contentType: "markdown",
        });
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setDocLoading(false);
    }
  }

  function handleNewDoc(nextKind: DocKind) {
    setSelectedDocId(null);
    setKind(nextKind);
    setTitle(KIND_DEFAULT_TITLE[nextKind]);
    setEditing(true);
    setDirty(false);
    setError(null);
    setTable(emptyTable());
    setBoard(emptyBoard());
    editor?.commands.clearContent();
    if (nextKind === "doc") setDirty(false);
  }

  async function handleSave() {
    if (!spaceId || !title.trim()) return;
    // 按类型取出要落库的正文：doc=Markdown，table/board=JSON
    let content = "";
    if (kind === "table") {
      content = serializeTable(table);
    } else if (kind === "board") {
      content = serializeBoard(board);
    } else {
      content = editor?.getMarkdown() ?? "";
    }

    setSaveBusy(true);
    setError(null);
    try {
      if (selectedDocId) {
        await updateDoc(selectedDocId, {
          title: title.trim(),
          content,
        });
      } else {
        const { doc: created } = await createDoc({
          space_id: spaceId,
          title: title.trim(),
          content,
          kind,
        });
        setSelectedDocId(created.id);
      }
      await refreshDocs();
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function handleDelete() {
    if (!selectedDocId) return;
    if (!confirm("确定删除这篇资料？删除后不可恢复。")) return;
    setDeleteBusy(true);
    setError(null);
    try {
      await deleteDoc(selectedDocId);
      setSelectedDocId(null);
      setTitle("");
      setKind("doc");
      setEditing(false);
      setDirty(false);
      setTable(emptyTable());
      setBoard(emptyBoard());
      editor?.commands.clearContent();
      await refreshDocs();
    } catch (e) {
      setError(errText(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleExport(exportKind: "md" | "docx" | "pdf" | "csv") {
    const t = title.trim() || KIND_DEFAULT_TITLE[kind];
    setError(null);
    try {
      if (exportKind === "csv") {
        const csv = tableToCsv(table);
        // 加 BOM，Excel 打开中文不乱码
        downloadBlob(
          `${t}.csv`,
          new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }),
        );
        return;
      }
      const md = editor?.getMarkdown() ?? "";
      setExportBusy(exportKind);
      if (exportKind === "md") {
        downloadMarkdown(t, md);
      } else if (exportKind === "docx") {
        await downloadDocx(t, md);
      } else {
        downloadPdf(t, md);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setExportBusy(null);
    }
  }

  // ── 工具栏动作 ──
  function setLink() {
    if (!editor) return;
    const prevUrl = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("输入链接地址：", prevUrl ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  if (spaces.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <p className="text-sm text-[var(--text-muted)]">
          还没有可用的空间，请先创建或加入一个空间。
        </p>
      </div>
    );
  }

  const showEditor = editing;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h1 className="text-lg font-semibold text-[var(--brand-ink)]">资料</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        写文档、记表格、摆看板，都放在同一个空间里；文档可导出 Markdown /
        Word / PDF。
      </p>

      {error ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {/* 空间选择 */}
      <div className="mt-4">
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
          空间
        </label>
        <select
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
          className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
        >
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* 资料列表 */}
      <section className="mt-6 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--brand-ink)]">
            全部资料
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleNewDoc("doc")}
              className={secondaryBtnClass()}
            >
              + 文档
            </button>
            <button
              type="button"
              onClick={() => handleNewDoc("table")}
              className={secondaryBtnClass()}
            >
              + 表格
            </button>
            <button
              type="button"
              onClick={() => handleNewDoc("board")}
              className={secondaryBtnClass()}
            >
              + 看板
            </button>
          </div>
        </div>

        {docsLoading ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">加载中…</p>
        ) : docs.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            还没有资料，点右上角「+ 文档 / + 表格 / + 看板」开始。
          </p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {docs.map((d) => {
              const meta = KIND_META[d.kind ?? "doc"];
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectDoc(d.id)}
                    className={[
                      "w-full rounded-xl border px-3 py-2 text-left transition-colors duration-200",
                      selectedDocId === d.id
                        ? "border-[#185FA5] bg-[#e8f0f7]"
                        : "border-[var(--border-muted)] hover:bg-[var(--surface-muted)]",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${meta.cls}`}
                      >
                        {meta.label}
                      </span>
                      <span className="truncate text-sm font-medium text-[var(--brand-ink)]">
                        {d.title}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                      更新于 {new Date(d.updated_at).toLocaleString()}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 编辑区：按资料类型渲染不同编辑器 */}
      {showEditor ? (
        <section className="mt-6 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
          {docLoading ? (
            <p className="text-sm text-[var(--text-muted)]">加载中…</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${KIND_META[kind].cls}`}
                >
                  {KIND_META[kind].label}
                </span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="标题"
                  className="min-w-0 flex-1 rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm font-medium text-[var(--brand-ink)] outline-none focus:border-brand"
                />
              </div>

              {kind === "doc" ? (
                <>
                  {/* 工具栏 */}
                  <div className="mt-3 flex flex-wrap items-center gap-0.5 rounded-xl border border-[var(--border-muted)] bg-[var(--surface-muted)] p-1">
                    <TbBtn
                      title="撤销"
                      onClick={() => editor?.chain().focus().undo().run()}
                      disabled={!editor?.can().undo()}
                    >
                      ↺
                    </TbBtn>
                    <TbBtn
                      title="重做"
                      onClick={() => editor?.chain().focus().redo().run()}
                      disabled={!editor?.can().redo()}
                    >
                      ↻
                    </TbBtn>
                    <ToolbarDivider />
                    {([1, 2, 3] as const).map((lvl) => (
                      <TbBtn
                        key={lvl}
                        title={`${lvl} 级标题`}
                        active={editor?.isActive("heading", { level: lvl })}
                        onClick={() =>
                          editor
                            ?.chain()
                            .focus()
                            .toggleHeading({ level: lvl })
                            .run()
                        }
                      >
                        H{lvl}
                      </TbBtn>
                    ))}
                    <ToolbarDivider />
                    <TbBtn
                      title="加粗"
                      active={editor?.isActive("bold")}
                      onClick={() => editor?.chain().focus().toggleBold().run()}
                    >
                      <b>B</b>
                    </TbBtn>
                    <TbBtn
                      title="斜体"
                      active={editor?.isActive("italic")}
                      onClick={() =>
                        editor?.chain().focus().toggleItalic().run()
                      }
                    >
                      <i>I</i>
                    </TbBtn>
                    <TbBtn
                      title="删除线"
                      active={editor?.isActive("strike")}
                      onClick={() =>
                        editor?.chain().focus().toggleStrike().run()
                      }
                    >
                      <s>S</s>
                    </TbBtn>
                    <TbBtn
                      title="行内代码"
                      active={editor?.isActive("code")}
                      mono
                      onClick={() => editor?.chain().focus().toggleCode().run()}
                    >
                      {"</>"}
                    </TbBtn>
                    <ToolbarDivider />
                    <TbBtn
                      title="无序列表"
                      active={editor?.isActive("bulletList")}
                      onClick={() =>
                        editor?.chain().focus().toggleBulletList().run()
                      }
                    >
                      UL
                    </TbBtn>
                    <TbBtn
                      title="有序列表"
                      active={editor?.isActive("orderedList")}
                      onClick={() =>
                        editor?.chain().focus().toggleOrderedList().run()
                      }
                    >
                      OL
                    </TbBtn>
                    <TbBtn
                      title="引用"
                      active={editor?.isActive("blockquote")}
                      onClick={() =>
                        editor?.chain().focus().toggleBlockquote().run()
                      }
                    >
                      ❝
                    </TbBtn>
                    <TbBtn
                      title="代码块"
                      active={editor?.isActive("codeBlock")}
                      mono
                      onClick={() =>
                        editor?.chain().focus().toggleCodeBlock().run()
                      }
                    >
                      {"{ }"}
                    </TbBtn>
                    <TbBtn
                      title="分割线"
                      onClick={() =>
                        editor?.chain().focus().setHorizontalRule().run()
                      }
                    >
                      —
                    </TbBtn>
                    <ToolbarDivider />
                    <TbBtn
                      title="插入链接"
                      active={editor?.isActive("link")}
                      onClick={setLink}
                    >
                      链
                    </TbBtn>
                  </div>

                  {/* 所见即所得编辑区 */}
                  <div className="mt-3 rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2">
                    <EditorContent editor={editor} />
                  </div>
                </>
              ) : kind === "table" ? (
                <DocsTableEditor
                  value={table}
                  onChange={(next) => {
                    setTable(next);
                    setDirty(true);
                  }}
                />
              ) : (
                <DocsBoardEditor
                  value={board}
                  onChange={(next) => {
                    setBoard(next);
                    setDirty(true);
                  }}
                />
              )}

              {/* 底部操作栏 */}
              <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                {saved ? (
                  <span className="mr-auto text-xs text-[var(--success)]">
                    已保存
                  </span>
                ) : dirty ? (
                  <span className="mr-auto text-xs text-[#b4761f]">
                    有未保存改动
                  </span>
                ) : (
                  <span className="mr-auto" />
                )}
                {selectedDocId ? (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleteBusy}
                    className={secondaryBtnClass()}
                  >
                    {deleteBusy ? "删除中…" : "删除"}
                  </button>
                ) : null}
                {kind === "doc" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleExport("md")}
                      disabled={exportBusy !== null}
                      className={secondaryBtnClass()}
                    >
                      {exportBusy === "md" ? "导出中…" : "Markdown"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExport("docx")}
                      disabled={exportBusy !== null}
                      className={secondaryBtnClass()}
                    >
                      {exportBusy === "docx" ? "导出中…" : "Word"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExport("pdf")}
                      disabled={exportBusy !== null}
                      className={secondaryBtnClass()}
                    >
                      {exportBusy === "pdf" ? "导出中…" : "PDF"}
                    </button>
                  </>
                ) : kind === "table" ? (
                  <button
                    type="button"
                    onClick={() => handleExport("csv")}
                    className={secondaryBtnClass()}
                  >
                    导出 CSV
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveBusy || !title.trim()}
                  className={primaryBtnClass()}
                >
                  {saveBusy
                    ? "保存中…"
                    : selectedDocId
                      ? "保存修改"
                      : "保存"}
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {/* 附件 */}
      <section className="mt-6 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--brand-ink)]">
            附件{selectedDocId ? "（本篇资料）" : "（空间）"}
          </h2>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              onChange={(e) => handleUploadFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className={secondaryBtnClass()}
            >
              {uploading ? "上传中…" : "上传附件"}
            </button>
          </div>
        </div>

        {attachmentsLoading ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">加载附件…</p>
        ) : attachments.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            {selectedDocId
              ? "这篇资料还没有附件，点「上传附件」添加。"
              : "这个空间还没有独立附件，点「上传附件」添加。"}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {attachments.map((att) => {
              const publicUrl = supabase.storage
                .from("library")
                .getPublicUrl(att.bucket_path).data.publicUrl;
              return (
                <li
                  key={att.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-muted)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <a
                      href={publicUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-sm font-medium text-[var(--brand-ink)] hover:text-[#185FA5]"
                    >
                      {att.name}
                    </a>
                    <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                      {formatBytes(att.size)} · 上传于{" "}
                      {new Date(att.created_at).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteAttachment(att.id)}
                    className="shrink-0 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    删除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
