import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = {
  email?: string;
};

// 临时密码字符集：去掉 0/O、1/l 等易混淆字符，方便口头/纸质转交
const LOWER = "abcdefghjkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function randFrom(set: string): string {
  return set[randomBytes(1)[0] % set.length];
}

/** 生成 12 位强随机密码：前 4 位保证四类字符各至少一个，其余从全集随机。
 *  仅用于 updateUserById 写入，不回传前端（管理员不接触明文）。 */
function generateTempPassword(): string {
  return [
    randFrom(LOWER),
    randFrom(UPPER),
    randFrom(DIGITS),
    randFrom(SYMBOLS),
    ...Array.from({ length: 8 }, () => randFrom(ALL)),
  ].join("");
}

/**
 * 管理员协助重置密码：已登录的管理员凭「目标邮箱」强改他人密码。
 * 密码由服务端生成强随机值写入（API 要求必须传值，管理员不接触明文），
 * 但**不回传**；仅回传新一次性恢复码，管理员转交用户后，用户凭该码在
 * /forgot-password 页面自助重设自己的密码（全程管理员不碰任何明文密码）。
 *
 * 鉴权分两层：
 *   1) 调用者必须带着有效会话（anon 服务端客户端 getUser 校验）；
 *   2) 该会话对应的 profiles.is_admin 必须为 true（service_role 直读，绕过 RLS）。
 * 实际改密用 SUPABASE_SERVICE_ROLE_KEY（仅服务端，切勿暴露给前端）。
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json(
      { error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" },
      { status: 500 },
    );
  }
  if (!serviceKey) {
    // 不向客户端暴露具体缺哪个环境变量
    return NextResponse.json(
      { error: "重置服务暂时不可用，请联系系统运维。" },
      { status: 500 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效请求" }, { status: 400 });
  }

  const email = (body.email ?? "").trim();

  if (!email) {
    return NextResponse.json({ error: "请填写目标邮箱" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }

  // 1) 校验调用者登录态（用 anon 服务端客户端读取请求里的会话 cookie）
  const caller = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll() {
        // 本接口不回写 cookie，留空即可
      },
    },
  });
  const {
    data: { user },
    error: userErr,
  } = await caller.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "请先以管理员身份登录" }, { status: 401 });
  }

  // 2) 校验调用者是否为管理员（service_role 直读 profiles，绕过 RLS）
  const admin = createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: callerProfile, error: profErr } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();
  if (profErr || !callerProfile?.is_admin) {
    return NextResponse.json(
      { error: "无权限：仅应用管理员可执行此操作" },
      { status: 403 },
    );
  }

  // ⚠️ 安全：管理员重置是高风险写操作，按 IP 限流防滥用
  const limited = rateLimit(`adminreset:${clientIp(request)}`, 10, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      {
        error: `操作过于频繁，请 ${limited.retryAfterSec} 秒后再试`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfterSec) },
      },
    );
  }

  // 3) 按邮箱解析目标用户（profiles.email 是规范登录邮箱）
  const { data: target, error: targetErr } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single();
  if (targetErr || !target) {
    return NextResponse.json({ error: "目标邮箱不存在" }, { status: 400 });
  }

  // 4) 服务端生成强随机密码写入（不回传前端），service_role 绕过会话，目标无需旧密码/无需登录
  const tempPassword = generateTempPassword();
  const { error: updateErr } = await admin.auth.admin.updateUserById(
    target.id,
    { password: tempPassword },
  );
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 400 });
  }

  // 注：updateUserById 改密码默认会撤销该用户全部 refresh token（所有设备强制登出），
  //     无需额外调用 signOut；下面重生成的恢复码旧码立即失效，进一步封堵旧入口。

  // 5) 同时重生成一次性恢复码（旧码立即失效），回传给管理员转交用户。
  //    注意：supabase-js 的 rpc() 失败不抛异常而是返回 { error }，必须显式检查；
  //    若写码失败绝不能把"假码"发给管理员，直接报错让管理员重试即可
  //    （重试会重新生成临时密码+恢复码，安全无副作用）。
  const recoveryCode = randomBytes(8).toString("hex");
  const { error: codeErr } = await admin.rpc("set_recovery_code", {
    p_user_id: target.id,
    p_code: recoveryCode,
  });
  if (codeErr) {
    console.error("[admin-reset] set_recovery_code failed:", codeErr.message);
    return NextResponse.json(
      { error: "恢复码写入失败，请重试（重试会重新生成新凭证）" },
      { status: 500 },
    );
  }

  // 写审计日志（补「会被记录」的欠账）。best-effort：supabase-js 的 rpc() 失败不抛异常
  // 而是返回 { error }，必须显式检查；记录失败仅留日志，不阻断已成功的重置。
  const { error: auditErr } = await admin.rpc("log_admin_action", {
    p_actor_id: user.id,
    p_action: "admin_password_reset",
    p_target_type: "user",
    p_target_id: target.id,
    p_detail: { email, recovery_code_issued: true },
  });
  if (auditErr) {
    console.error("[admin-reset] audit log failed:", auditErr.message);
  }

  return NextResponse.json({ ok: true, recoveryCode });
}
