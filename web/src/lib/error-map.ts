/**
 * 数据库 / 网络错误的中文映射。
 *
 * 背景：此前二十多处直接 `setMsg(error.message)`，中文用户会看到
 * `duplicate key value violates unique constraint "todos_pkey"`、
 * `JWT expired`、`permission denied for table todos` 这类英文原文。
 * 登录页早就有 translateAuthError 做了同样的事，这里抽成全局复用件。
 */

const RULES: Array<{ test: RegExp; text: string }> = [
  { test: /duplicate key|unique constraint|already exists/i, text: "该数据已存在，请勿重复提交" },
  { test: /row-level security|permission denied|not allowed|unauthorized|forbidden/i, text: "没有权限执行此操作" },
  { test: /jwt expired|token.*expired|refresh_token_not_found/i, text: "登录已过期，请重新登录" },
  { test: /invalid jwt|invalid.*token/i, text: "登录状态异常，请重新登录" },
  { test: /invalid input syntax|invalid.*uuid|malformed/i, text: "数据格式不正确，请检查后重试" },
  { test: /null value in column|violates not-null/i, text: "必填信息未填写完整" },
  { test: /violates foreign key|foreign key constraint/i, text: "关联数据不存在，请刷新页面后重试" },
  { test: /violates check constraint/i, text: "数据不符合要求，请检查后重试" },
  { test: /failed to fetch|network|networkerror|fetcherror|load failed/i, text: "网络连接失败，请检查网络后重试" },
  { test: /timeout|timed out/i, text: "请求超时，请稍后重试" },
  { test: /bucket not found|storage/i, text: "文件存储不可用，请联系管理员" },
  { test: /rate limit|too many requests/i, text: "操作过于频繁，请稍后再试" },
];

const FALLBACK = "操作失败，请稍后重试";

/** 把任意错误（Error / PostgREST / Supabase message）转成可展示的中文文案 */
export function mapDbError(raw: unknown): string {
  if (!raw) return FALLBACK;
  const message =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
        ? raw.message
        : (raw as { message?: string })?.message ?? "";
  const text = message.trim();
  if (!text) return FALLBACK;
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.text;
  }
  // 无法识别的英文报错不直接抛给用户
  return /^[\x00-\x7F\s]*$/.test(text) && text.length > 24 ? FALLBACK : text;
}

/**
 * 认证类错误（登录 / 注册 / 找回）的中文映射。
 *
 * 此前 /auth/password 接口直接把 `Invalid login credentials` 原样返回给前端，
 * 登录页自己有一份 translateAuthError 做翻译，但接口层没有——
 * 走接口路径（比如脚本、其他入口）的用户会看到英文。这里统一成一个来源。
 */
const AUTH_RULES: Array<{ test: RegExp; text: string }> = [
  { test: /invalid login credentials|invalid.*credentials/i, text: "邮箱或密码错误" },
  { test: /email not confirmed/i, text: "邮箱尚未完成验证，请先查收验证邮件" },
  { test: /user already registered|already been registered/i, text: "该邮箱已注册，请直接登录" },
  { test: /password should be at least|password.*at least/i, text: "密码至少 6 位" },
  { test: /weak password/i, text: "密码强度不足，请混合字母、数字和符号" },
  { test: /signups not allowed|signup.*disabled/i, text: "当前未开放注册，请联系管理员" },
  { test: /invalid format|unable to validate email|invalid email/i, text: "邮箱格式不正确" },
  { test: /email rate limit|sms rate limit|over_email_send_rate_limit/i, text: "发送过于频繁，请稍后再试" },
  { test: /user not found|no user/i, text: "该邮箱尚未注册" },
];

export function mapAuthError(raw: unknown): string {
  if (!raw) return FALLBACK;
  const message =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
        ? raw.message
        : (raw as { message?: string })?.message ?? "";
  const text = message.trim();
  if (!text) return FALLBACK;
  for (const rule of AUTH_RULES) {
    if (rule.test.test(text)) return rule.text;
  }
  return mapDbError(text);
}

/** 带前缀的映射，例如 `保存失败：xxx` */
export function mapDbErrorWith(action: string, raw: unknown): string {
  return `${action}失败：${mapDbError(raw)}`;
}
