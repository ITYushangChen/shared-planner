/**
 * 网页抓取：URL → { title, content }（正文纯文本）。
 *
 * P0 用原生 fetch + 正则解析 HTML，不引入 cheerio，够跑通「连接网页知识源」闭环；
 * 处理要点：15s 超时、自动跟随重定向、按 Content-Type / meta 检测编码（含 GBK）、
 * 去掉 script/style/noscript、压缩空白、解码 HTML 实体。
 */

const FETCH_TIMEOUT_MS = 15000;

function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
  };
  return s
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => named[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** 优先 Content-Type 的 charset，其次 <meta charset>，最后默认 utf-8 */
function detectCharset(header: string | null, headBytes: Uint8Array): string {
  const fromHeader = header?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();

  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    headBytes.slice(0, 2048),
  );
  const fromMeta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  return fromMeta?.toLowerCase() || "utf-8";
}

function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  return decodeHtmlEntities(
    withoutBlocks
      .replace(/<[^>]+>/g, " ") // 去掉所有标签
      .replace(/\s+/g, " "), // 压缩空白
  ).trim();
}

export async function fetchWebPage(
  url: string,
): Promise<{ title: string; content: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ShareTodoKnowledgeBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      /abort/i.test(msg) ? `抓取超时（${FETCH_TIMEOUT_MS / 1000}s）：${url}` : `抓取失败：${msg}`,
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`网页返回 ${res.status}：${url}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const charset = detectCharset(res.headers.get("content-type"), bytes);

  let html: string;
  try {
    html = new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : url;

  return { title, content: htmlToText(html) };
}
