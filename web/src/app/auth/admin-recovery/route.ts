import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = {
  email?: string;
  action?: "regen" | "revoke";
};

/**
 * 管理员恢复码管理：
 *   - regen：重新生成一次性恢复码（明文仅回传这一次，库内存哈希），不改动用户密码；
 *   - revoke：吊销现有恢复码（置 NULL），用户将无法自助找回密码，只能再找管理员重置。
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
  const action: "regen" | "revoke" = body.action === "revoke" ? "revoke" : "regen";
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

  const limited = rateLimit(`adminrecovery:${clientIp(request)}`, 20, 60 * 60 * 1000);
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

  let recoveryCode = "";
  if (action === "regen") {
    recoveryCode = randomBytes(8).toString("hex");
    const { error: codeErr } = await admin.rpc("set_recovery_code", {
      p_user_id: target.id,
      p_code: recoveryCode,
    });
    if (codeErr) {
      console.error("[admin-recovery] set_recovery_code failed:", (codeErr as Error).message);
      return NextResponse.json({ error: "恢复码写入失败，请重试" }, { status: 500 });
    }
  } else {
    const { error: revErr } = await admin.rpc("revoke_recovery_code", {
      p_user_id: target.id,
    });
    if (revErr) {
      console.error("[admin-recovery] revoke_recovery_code failed:", (revErr as Error).message);
      return NextResponse.json({ error: "吊销失败，请重试" }, { status: 500 });
    }
  }

  const { error: auditErr } = await admin.rpc("log_admin_action", {
    p_actor_id: user.id,
    p_action: action === "regen" ? "admin_recovery_regen" : "admin_recovery_revoke",
    p_target_type: "user",
    p_target_id: target.id,
    p_detail: { email },
  });
  if (auditErr) console.error("[admin-recovery] audit failed:", (auditErr as Error).message);

  return NextResponse.json(
    action === "regen" ? { ok: true, recoveryCode } : { ok: true },
  );
}
