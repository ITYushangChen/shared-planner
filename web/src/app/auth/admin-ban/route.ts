import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = {
  email?: string;
  action?: "ban" | "unban";
  reason?: string;
};

// 封禁时顺手吊销其所有会话：updateUserById 改一个随机强密码（不回传），
// Supabase 会撤销该用户全部 refresh token（所有设备强制登出）。
function genStrongPassword(): string {
  const L = "abcdefghjkmnpqrstuvwxyz";
  const U = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const D = "23456789";
  const S = "!@#$%^&*";
  const all = L + U + D + S;
  const r = () => all[randomBytes(1)[0] % all.length];
  return [
    L[randomBytes(1)[0] % L.length],
    U[randomBytes(1)[0] % U.length],
    D[randomBytes(1)[0] % D.length],
    S[randomBytes(1)[0] % S.length],
    ...Array.from({ length: 8 }, () => r()),
  ].join("");
}

/**
 * 管理员封禁 / 解封账号。
 * 鉴权同 admin-reset：调用者须带有效会话且 profiles.is_admin=true（service_role 直读绕过 RLS）。
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" }, { status: 500 });
  }
  if (!serviceKey) {
    return NextResponse.json({ error: "封禁服务暂时不可用，请联系系统运维。" }, { status: 500 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效请求" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const action: "ban" | "unban" = body.action === "unban" ? "unban" : "ban";
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

  // 3) 限流
  const limited = rateLimit(`adminban:${clientIp(request)}`, 20, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: `操作过于频繁，请 ${limited.retryAfterSec} 秒后再试` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } },
    );
  }

  // 4) 解析目标
  const { data: target, error: targetErr } = (await admin
    .from("profiles")
    .select("id, is_admin, banned")
    .eq("email", email)
    .single()) as {
    data: { id: string; is_admin: boolean; banned: boolean } | null;
    error: unknown;
  };
  if (targetErr || !target) {
    return NextResponse.json({ error: "目标邮箱不存在" }, { status: 400 });
  }
  if (target.id === user.id) {
    return NextResponse.json({ error: "不能对自己执行该操作" }, { status: 400 });
  }
  if (target.is_admin) {
    return NextResponse.json({ error: "不能封禁其他管理员（避免锁死后台）" }, { status: 400 });
  }

  // 5) 执行
  if (action === "ban") {
    const { error: upErr } = await admin
      .from("profiles")
      .update({
        banned: true,
        banned_at: new Date().toISOString(),
        banned_reason: (body.reason ?? "").trim() || null,
      })
      .eq("id", target.id);
    if (upErr) {
      return NextResponse.json({ error: `封禁失败：${(upErr as Error).message}` }, { status: 500 });
    }
    // 顺手吊销其所有会话
    const { error: soErr } = await admin.auth.admin.updateUserById(target.id, {
      password: genStrongPassword(),
    });
    if (soErr) console.error("[admin-ban] signout-on-ban failed:", (soErr as Error).message);
  } else {
    const { error: upErr } = await admin
      .from("profiles")
      .update({ banned: false, banned_at: null, banned_reason: null })
      .eq("id", target.id);
    if (upErr) {
      return NextResponse.json({ error: `解封失败：${(upErr as Error).message}` }, { status: 500 });
    }
  }

  // 6) 审计（best-effort：rpc 失败仅留日志不阻断）
  const { error: auditErr } = await admin.rpc("log_admin_action", {
    p_actor_id: user.id,
    p_action: action === "ban" ? "admin_ban" : "admin_unban",
    p_target_type: "user",
    p_target_id: target.id,
    p_detail: { email, reason: body.reason ?? null },
  });
  if (auditErr) console.error("[admin-ban] audit failed:", (auditErr as Error).message);

  return NextResponse.json({ ok: true, action });
}
