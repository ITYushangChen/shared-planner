/**
 * 站内跳转白名单。
 *
 * 背景：`next.startsWith("/")` 这类判断挡不住协议相对 URL（`//evil.com`）和反斜杠
 * 变体（`/\evil.com`），两者都以 `/` 开头，但被浏览器解析后会跳到外站；
 * `origin + next` 的拼接方式更危险 —— `next=@evil.com/` 会让 `origin` 的主机名
 * 退化成 URL userinfo，真实 host 变成 evil.com。
 *
 * 所以任何来自 query 的跳转目标，都必须先过这个函数。
 */
export const DEFAULT_APP_PATH = "/app?view=calendar&range=week";

/**
 * 只接受「站内绝对路径」：以单个 `/` 开头，第二个字符不能是 `/` 或 `\`，
 * 不含协议、不含控制字符。其余一律回落到 fallback。
 */
export function safeInternalPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_APP_PATH,
): string {
  if (!raw) return fallback;
  // 控制字符 / 换行（响应头注入与日志伪造）
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  // 必须以单个斜杠开头，且第二个字符不是 / 或 \
  if (!/^\/(?![/\\])/.test(raw)) return fallback;
  // 任何形式的协议（http://、javascript:、data:）
  if (raw.includes(":")) {
    // 允许路径里出现 ":" 的位置只能是 query 或 hash 之后
    const beforeQuery = raw.split(/[?#]/)[0];
    if (beforeQuery.includes(":")) return fallback;
  }
  return raw;
}

/** 服务端重定向用：只会拼接 origin，仍需先过白名单 */
export function safeRedirectTarget(raw: string | null | undefined): string {
  return safeInternalPath(raw, DEFAULT_APP_PATH);
}
