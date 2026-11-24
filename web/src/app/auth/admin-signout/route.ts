import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = { email?: string };

// 强制下线 = updateUserById 改一个随机强密码（不回传）。
// Supabase 会撤销该用户全部 refresh token，其所有设备的会话随之失效，下次需重新登录。
// 注意：不修改用户「真正」的密码意图——用户仍可用恢复码/找回流程重设，这里只是吊销令牌。
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
 * 管理员强制下线：吊销目标用户所有设备的会话（不接触其明文密码）。
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" }, { status: 500 });
  }
  if (!serviceKey) {
    return NextResponse.json({ error: "该服务暂时不可用，请联系系统运维。" }, { status: 500 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效请求" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }

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

  const limited = rateLimit(`adminsignout:${clientIp(request)}`, 20, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: `操作过于频繁，请 ${limited.retryAfterSec} 秒后再试` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } },
    );
  }

  const { data: target, error: targetErr } = (await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single()) as { data: { id: string } | null; error: unknown };
  if (targetErr || !target) {
    return NextResponse.json({ error: "目标邮箱不存在" }, { status: 400 });
  }

  const { error: soErr } = await admin.auth.admin.updateUserById(target.id, {
    password: genStrongPassword(),
  });
  if (soErr) {
    return NextResponse.json({ error: (soErr as Error).message }, { status: 400 });
  }

  const { error: auditErr } = await admin.rpc("log_admin_action", {
    p_actor_id: user.id,
    p_action: "admin_force_signout",
    p_target_type: "user",
    p_target_id: target.id,
    p_detail: { email },
  });
  if (auditErr) console.error("[admin-signout] audit failed:", (auditErr as Error).message);

  return NextResponse.json({ ok: true });
}
