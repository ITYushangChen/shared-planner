/**
 * 前端统一错误上报：把任意异常（含未捕获异常）上报到 /auth/report-error，
 * 最终落到 app_error_log，供管理员在 /admin 错误日志页查看。
 *
 * 设计为 fire-and-forget：上报自身出错时静默吞掉，绝不因上报再次抛错。
 */

const MAX_LEN = 1800;

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function toMeta(error: unknown): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (error instanceof Error && error.stack) {
    meta.stack = error.stack.slice(0, 4000);
  }
  if (typeof window !== "undefined" && window.location?.href) {
    meta.url = window.location.href;
  }
  return Object.keys(meta).length ? meta : undefined;
}

/**
 * 上报一次错误。
 * @param operation 报错操作/来源，如「加载空间」「AI 排程」「创建任务」
 * @param error     错误对象或文案
 * @param meta      附加上下文（可选）
 */
export function reportError(
  operation: string,
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  const message = toMessage(error).slice(0, MAX_LEN);
  const meta = { ...toMeta(error), ...(extra ?? {}) };
  if (Object.keys(meta).length === 0) delete meta.url;

  try {
    fetch("/auth/report-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        message,
        operation,
        level: "error",
        meta: Object.keys(meta).length ? meta : undefined,
      }),
    }).catch(() => {
      /* 上报失败静默忽略，避免递归上报 */
    });
  } catch {
    /* 同上 */
  }
}
