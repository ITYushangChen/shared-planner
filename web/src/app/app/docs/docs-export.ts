import { marked } from "marked";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

/** 通用 Blob 下载（照抄 settings/data-panel.tsx） */
export function downloadBlob(filename: string, blob: Blob) {
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

/** 安全文件名：去掉路径与非法字符 */
function safeName(title: string): string {
  const s = title.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名文档";
  return s.slice(0, 60);
}

/** 下载 Markdown（带 BOM，保证中文正常） */
export function downloadMarkdown(title: string, markdown: string) {
  const blob = new Blob([`\uFEFF${markdown}`], {
    type: "text/markdown;charset=utf-8",
  });
  downloadBlob(`${safeName(title)}.md`, blob);
}

// ---------- Markdown → docx ----------

type AnyToken = any;

type HeadingLevelValue = (typeof HeadingLevel)[keyof typeof HeadingLevel];

const HEADING_LEVELS: Record<number, HeadingLevelValue> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

interface InlineOpts {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
}

/** 递归把 inline tokens 转成 TextRun[]（处理加粗/斜体/行内代码/链接/删除线） */
function renderInline(
  tokens: AnyToken[] | undefined,
  opts: InlineOpts = {},
): TextRun[] {
  const runs: TextRun[] = [];
  const push = (text: string, o: InlineOpts) => {
    if (!text) return;
    runs.push(
      new TextRun({
        text,
        bold: o.bold,
        italics: o.italics,
        strike: o.strike,
      }),
    );
  };
  for (const t of tokens || []) {
    switch (t?.type) {
      case "text":
        push(t.text ?? "", opts);
        break;
      case "strong":
        runs.push(...renderInline(t.tokens, { ...opts, bold: true }));
        break;
      case "em":
        runs.push(...renderInline(t.tokens, { ...opts, italics: true }));
        break;
      case "del":
        runs.push(...renderInline(t.tokens, { ...opts, strike: true }));
        break;
      case "codespan":
        runs.push(new TextRun({ text: t.text ?? "", font: "Consolas" }));
        break;
      case "link":
        runs.push(
          new TextRun({
            text: (t.text ?? "").replace(/\n/g, " "),
            color: "1155CC",
            underline: {},
          }),
        );
        break;
      case "br":
        runs.push(new TextRun({ break: 1 }));
        break;
      case "image":
        push(t.text ?? "[图片]", opts);
        break;
      default:
        if (t?.text) push(t.text, opts);
        break;
    }
  }
  return runs;
}

/** 从 list item 的块级 tokens 里提取 inline tokens（取首个 text token） */
function extractItemInline(tokens: AnyToken[] | undefined): AnyToken[] {
  for (const t of tokens || []) {
    if (t?.type === "text" && Array.isArray(t.tokens)) return t.tokens;
    if (t?.type === "paragraph" && Array.isArray(t.tokens)) return t.tokens;
  }
  return [];
}

/** 组装 docx 的段落列表 */
function buildChildren(tokens: AnyToken[]): Paragraph[] {
  const out: Paragraph[] = [];

  const walk = (list: AnyToken[]) => {
    for (const t of list || []) {
      switch (t?.type) {
        case "heading": {
          const lvl = Math.min(Math.max(t.depth ?? 1, 1), 6);
          out.push(
            new Paragraph({
              heading: HEADING_LEVELS[lvl],
              children: renderInline(t.tokens),
            }),
          );
          break;
        }
        case "paragraph":
          out.push(new Paragraph({ children: renderInline(t.tokens) }));
          break;
        case "list": {
          const ordered = !!t.ordered;
          (t.items || []).forEach((item: AnyToken) => {
            const inline = extractItemInline(item.tokens);
            const children = renderInline(inline);
            if (ordered) {
              out.push(
                new Paragraph({
                  children,
                  numbering: { reference: "ordered-list", level: 0 },
                }),
              );
            } else {
              out.push(new Paragraph({ children, bullet: { level: 0 } }));
            }
          });
          break;
        }
        case "blockquote":
          // 无原生引用节点，用左边框 + 缩进模拟
          (t.tokens || []).forEach((inner: AnyToken) => {
            if (inner?.type === "paragraph") {
              out.push(
                new Paragraph({
                  children: renderInline(inner.tokens),
                  indent: { left: 360 },
                  border: {
                    left: {
                      style: BorderStyle.SINGLE,
                      size: 12,
                      color: "CCCCCC",
                      space: 8,
                    },
                  },
                }),
              );
            } else {
              walk([inner]);
            }
          });
          break;
        case "code": {
          const lines = (t.text ?? "").split("\n");
          lines.forEach((line: string, i: number) => {
            out.push(
              new Paragraph({
                children: [new TextRun({ text: line || " ", font: "Consolas" })],
                shading: { fill: "F5F5F5" },
                spacing: { line: 240 },
              }),
            );
          });
          break;
        }
        case "hr":
          out.push(
            new Paragraph({
              border: {
                bottom: {
                  style: BorderStyle.SINGLE,
                  size: 6,
                  color: "CCCCCC",
                  space: 1,
                },
              },
            }),
          );
          break;
        case "space":
          break;
        case "table":
          // GFM 表格：编辑器不产生，但用户粘贴可能带入，简单转成纯文本段落兜底
          out.push(new Paragraph({ children: [new TextRun({ text: t.raw ?? "" })] }));
          break;
        default:
          if (t?.raw && t.type === "html") {
            // 忽略原始 HTML
          }
          break;
      }
    }
  };

  walk(tokens);
  return out;
}

/** 导出 docx（真 .docx，中文默认宋体） */
export async function downloadDocx(title: string, markdown: string) {
  const tokens = marked.lexer(markdown);
  const children = buildChildren(tokens as AnyToken[]);

  const doc = new Document({
    creator: "资料",
    title,
    styles: {
      default: {
        document: {
          run: { font: "宋体", size: 22 }, // 22 half-points = 11pt
        },
      },
    },
    numbering: {
      config: [
        {
          reference: "ordered-list",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(`${safeName(title)}.docx`, blob);
}

// ---------- PDF：打印另存为 ----------

/** Markdown → 独立 HTML（内联色值，供打印窗口使用） */
function markdownToPrintHtml(title: string, markdown: string): string {
  const body = marked.parse(markdown) as string;
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
         color: #3a3f42; font-size: 14px; line-height: 1.7; margin: 40px auto;
         max-width: 720px; padding: 0 16px; }
  h1 { font-size: 24px; color: #185fa5; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; }
  h2 { font-size: 20px; color: #185fa5; margin-top: 24px; }
  h3 { font-size: 17px; color: #3a3f42; margin-top: 20px; }
  h1,h2,h3 { font-weight: 600; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 24px; }
  li { margin: 4px 0; }
  blockquote { border-left: 4px solid #d5dee8; margin: 12px 0; padding: 4px 12px;
               color: #6b7280; }
  code { background: #f1f5f9; border-radius: 4px; padding: 1px 6px;
         font-family: Consolas, Monaco, monospace; font-size: 13px; }
  pre { background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 8px;
        padding: 12px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #d5dee8; padding: 6px 10px; text-align: left; }
  th { background: #eef4fb; }
  a { color: #185fa5; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
  @page { margin: 20mm; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${body}
<script>
  window.addEventListener("load", function () {
    // 等字体/内容就绪后再唤起打印
    setTimeout(function () { window.print(); }, 300);
  });
</script>
</body>
</html>`;
}

/** 下载 PDF：新窗口渲染 + 浏览器「打印 → 另存为 PDF」（中文零坑） */
export function downloadPdf(title: string, markdown: string) {
  const html = markdownToPrintHtml(title, markdown);
  const w = window.open("", "_blank");
  if (!w) {
    alert("浏览器拦截了弹窗，请允许本站弹窗后重试。");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
