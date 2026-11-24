import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 管理后台「操作记录」：读 admin_audit_log 审计日志（管理员关键写操作）。
 * 读取走 service_role（表已授权 service_role）。附带把 actor/target 的 UUID
 * 映射成邮箱，便于展示。
 */
export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" }, { status: 500 });
  }
  if (!serviceKey) {
    return NextResponse.json({ error: "操作记录服务暂时不可用，请联系系统运维。" }, { status: 500 });
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

  // 4) 读审计日志（按时间倒序）
  const { data: logs, error: logErr } = await admin
    .from("admin_audit_log")
    .select("id, actor_id, action, target_type, target_id, detail, created_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (logErr) {
    console.error("[admin-audit] read failed:", (logErr as Error).message);
    return NextResponse.json({ error: "读取操作记录失败，请稍后重试" }, { status: 500 });
  }

  // 5) 映射 UUID → 邮箱（actor / 用户类 target）
  const { data: profiles, error: profErr } = await admin
    .from("profiles")
    .select("id, email, display_name");
  if (profErr) {
    console.error("[admin-audit] profiles failed:", (profErr as Error).message);
    return NextResponse.json({ error: "读取操作记录失败，请稍后重试" }, { status: 500 });
  }
  const emailById = new Map<string, string>();
  for (const p of profiles ?? []) {
    if (p.email) emailById.set(p.id, p.email);
  }

  const rows = (logs ?? []).map((l) => ({
    id: l.id,
    action: l.action,
    actor_email: emailById.get(l.actor_id) ?? l.actor_id,
    target_type: l.target_type,
    target_email: l.target_type === "user" && l.target_id ? emailById.get(l.target_id) ?? null : null,
    detail: l.detail ?? {},
    created_at: l.created_at,
  }));

  return NextResponse.json({ logs: rows });
}
