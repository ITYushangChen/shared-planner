import "dotenv/config";

function read(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  corsOrigin: read("CORS_ORIGIN", "*"),
  supabaseUrl: read("SUPABASE_URL"),
  supabaseAnonKey: read("SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
  deepseekApiKey: read("DEEPSEEK_API_KEY"),
  deepseekBaseUrl: read("DEEPSEEK_BASE_URL", "https://api.deepseek.com").replace(
    /\/$/,
    "",
  ),
  deepseekModel: read("DEEPSEEK_MODEL", "deepseek-chat"),
  cronSecret: read("CRON_SECRET"),
  webBaseUrl: read("WEB_BASE_URL", "https://diary-service.top"), // 卡片按钮跳转用
  feishuAppId: read("FEISHU_APP_ID"),
  feishuAppSecret: read("FEISHU_APP_SECRET"),
  feishuReceiverMobile: read("FEISHU_RECEIVER_MOBILE"),
  feishuReceiverEmail: read("FEISHU_RECEIVER_EMAIL"),
  feishuReceiverUserId: read("FEISHU_RECEIVER_USER_ID"), // Supabase 内部 user_id（查时区/空间），非飞书 ID
  feishuReceiverOpenId: read("FEISHU_RECEIVER_OPEN_ID"), // 飞书 open_id（ou_ 开头，发消息推荐用这个）
  feishuReceiverFeishuUserId: read("FEISHU_RECEIVER_FEISHU_USER_ID"), // 飞书 user_id（企业内用户 ID）
  feishuVerificationToken: read("FEISHU_VERIFICATION_TOKEN"), // 可选：卡片回调验签（配了就强校验）
};

export function assertRuntimeEnv(): void {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DEEPSEEK_API_KEY",
  ] as const;

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}
