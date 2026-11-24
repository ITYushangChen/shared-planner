import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 管理后台「错误日志」：读 app_error_log（报错信息 / 报错操作 / 时间）。
 * 读取走 service_role（表已授权 service_role）。
 */
export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" }, { status: 500 });
  }
  if (!serviceKey) {
    return NextResponse.json({ error: "错误日志服务暂时不可用，请联系系统运维。" }, { status: 500 });
  }

  // 1) 校验调用者登录态
  const caller = createServerClient(url, anon, {
    cookies: { getAll: () => request.cookies.getAll(), setAll() {} },
  });
  const {
    data: { user },
    error: userErr,
  } = await caller.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "请先以管理员身份登录" }, { status: 401 });
  }

  // 2) 校验管理员
  const admin = createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: me, error: meErr } = (await admin
    .from("profiles")
    .select("id, is_admin")
    .eq("id", user.id)
    .single()) as { data: { id: string; is_admin: boolean } | null; error: unknown };
  if (meErr || !me?.is_admin) {
    return NextResponse.json({ error: "无权限：仅应用管理员可执行此操作" }, { status: 403 });
  }

  // 3) 分页参数
  const sp = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(parseInt(sp.get("limit") ?? "100", 10) || 100, 1), 200);
  const offset = Math.max(parseInt(sp.get("offset") ?? "0", 10) || 0, 0);

  // 4) 读错误日志（按时间倒序）
  const { data: logs, error: logErr } = await admin
    .from("app_error_log")
    .select("id, message, operation, level, meta, created_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (logErr) {
    console.error("[admin-errors] read failed:", (logErr as Error).message);
    return NextResponse.json({ error: "读取错误日志失败，请稍后重试" }, { status: 500 });
  }

  return NextResponse.json({
    logs: (logs ?? []).map((l) => ({
      id: l.id,
      message: l.message,
      operation: l.operation ?? null,
      level: l.level ?? "error",
      meta: l.meta ?? {},
      created_at: l.created_at,
    })),
  });
}
