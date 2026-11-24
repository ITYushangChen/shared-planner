import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = {
  message?: string;
  operation?: string;
  level?: string;
  meta?: unknown;
};

const MAX_MESSAGE = 2000;
const MAX_OPERATION = 200;
const LEVELS = new Set(["error", "warn", "info"]);

/**
 * 应用错误上报端点：前端在任意登录态（含未登录）下，把未捕获异常 / 接口报错
 * 统一上报到 app_error_log，供管理员在 /admin 错误日志页查看。
 *
 * 写入走 service_role（SECURITY DEFINER 的 log_app_error 亦可用，但这里用
 * service_role 客户端最稳，且不依赖前端会话）。按 IP 限流防刷。
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const operation = (body.operation ?? "").trim().slice(0, MAX_OPERATION) || null;
  const level = body.level && LEVELS.has(body.level) ? body.level : "error";
  let meta: Record<string, unknown> = {};
  if (body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)) {
    meta = body.meta as Record<string, unknown>;
  }

  // 限流：单 IP 每分钟最多 60 条，防被恶意刷爆日志表
  const limited = rateLimit(`reporterr:${clientIp(request)}`, 60, 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  const admin = createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error } = await admin.rpc("log_app_error", {
    p_message: message.slice(0, MAX_MESSAGE),
    p_operation: operation,
    p_level: level,
    p_meta: meta,
  });
  if (error) {
    console.error("[report-error] log_app_error failed:", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
