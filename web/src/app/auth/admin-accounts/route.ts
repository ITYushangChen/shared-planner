import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = {
  email?: string;
  action?: "promote" | "demote";
};

/**
 * 管理后台「账户管理」：GET 列出所有账号（含空间个数，不含空间名称/任务），
 * POST 升级（promote）/ 降级（demote）管理员标志。
 *
 * 鉴权同 admin-reset：调用者须带有效会话且 profiles.is_admin=true（service_role 直读绕过 RLS）。
 * 账户列表与空间个数由 SECURITY DEFINER 函数 admin_list_accounts() 提供（仅 service_role 可调）。
 */
export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" }, { status: 500 });
  }
  if (!serviceKey) {
    return NextResponse.json({ error: "账户管理服务暂时不可用，请联系系统运维。" }, { status: 500 });
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

  // 3) 读账户列表（含空间个数）
  const { data: accounts, error: listErr } = await admin.rpc("admin_list_accounts");
  if (listErr) {
    console.error("[admin-accounts] admin_list_accounts failed:", (listErr as Error).message);
    return NextResponse.json({ error: "读取账户列表失败，请稍后重试" }, { status: 500 });
  }

  return NextResponse.json({ accounts: accounts ?? [] });
}

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" }, { status: 500 });
  }
  if (!serviceKey) {
    return NextResponse.json({ error: "账户管理服务暂时不可用，请联系系统运维。" }, { status: 500 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效请求" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const action: "promote" | "demote" = body.action === "demote" ? "demote" : "promote";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
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

  // 3) 限流（升级/降级是敏感写操作）
  const limited = rateLimit(`adminrole:${clientIp(request)}`, 20, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: `操作过于频繁，请 ${limited.retryAfterSec} 秒后再试` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } },
    );
  }

  // 4) 解析目标
  const { data: target, error: targetErr } = (await admin
    .from("profiles")
    .select("id, is_admin")
    .eq("email", email)
    .single()) as { data: { id: string; is_admin: boolean } | null; error: unknown };
  if (targetErr || !target) {
    return NextResponse.json({ error: "目标邮箱不存在" }, { status: 400 });
  }

  if (action === "demote") {
    if (target.id === user.id) {
      return NextResponse.json({ error: "不能降级自己（避免锁死后台）" }, { status: 400 });
    }
    if (!target.is_admin) {
      return NextResponse.json({ error: "该账号本就是普通成员，无需降级" }, { status: 400 });
    }
    // 至少保留一个管理员，防止把最后一个管理员降级导致后台无人可进
    const { count: adminCount } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("is_admin", true);
    if ((adminCount ?? 1) <= 1) {
      return NextResponse.json({ error: "至少保留一个管理员，无法继续降级" }, { status: 400 });
    }
    const { error: upErr } = await admin
      .from("profiles")
      .update({ is_admin: false })
      .eq("id", target.id);
    if (upErr) {
      return NextResponse.json({ error: `降级失败：${(upErr as Error).message}` }, { status: 500 });
    }
  } else {
    if (target.is_admin) {
      return NextResponse.json({ error: "该账号已是管理员，无需升级" }, { status: 400 });
    }
    const { error: upErr } = await admin
      .from("profiles")
      .update({ is_admin: true })
      .eq("id", target.id);
    if (upErr) {
      return NextResponse.json({ error: `升级失败：${(upErr as Error).message}` }, { status: 500 });
    }
  }

  // 5) 审计（best-effort：rpc 失败仅留日志不阻断）
  const { error: auditErr } = await admin.rpc("log_admin_action", {
    p_actor_id: user.id,
    p_action: action === "promote" ? "admin_promote" : "admin_demote",
    p_target_type: "user",
    p_target_id: target.id,
    p_detail: { email },
  });
  if (auditErr) console.error("[admin-accounts] audit failed:", (auditErr as Error).message);

  return NextResponse.json({ ok: true, action });
}
