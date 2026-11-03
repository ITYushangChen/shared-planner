import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = {
  email?: string;
  code?: string;
  newPassword?: string;
};

/**
 * 免邮件密码找回：凭「邮箱 + 一次性恢复码」直接重置密码（不依赖 SMTP）。
 * 需要服务端配置 SUPABASE_SERVICE_ROLE_KEY（仅服务端使用，切勿暴露给前端）。
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    return NextResponse.json(
      { error: "缺少 NEXT_PUBLIC_SUPABASE_URL" },
      { status: 500 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效请求" }, { status: 400 });
  }

  const email = body.email?.trim() ?? "";
  const code = (body.code ?? "").trim();
  const newPassword = body.newPassword ?? "";

  if (!email || !code || !newPassword) {
    return NextResponse.json(
      { error: "请填写邮箱、恢复码和新密码" },
      { status: 400 },
    );
  }
  // ⚠️ 安全：找回码校验此前无任何限流，可被反复调用。按 IP + 邮箱限。
  const limited = rateLimit(
    `recover:${clientIp(request)}:${email.toLowerCase()}`,
    8,
    15 * 60 * 1000,
  );
  if (!limited.ok) {
    return NextResponse.json(
      { error: `尝试次数过多，请 ${limited.retryAfterSec} 秒后再试` },
      {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfterSec) },
      },
    );
  }
  if (newPassword.length < 6) {
    return NextResponse.json({ error: "新密码至少 6 位" }, { status: 400 });
  }
  const types = [
    /\d/.test(newPassword),
    /[a-zA-Z]/.test(newPassword),
    /[^a-zA-Z0-9]/.test(newPassword),
  ].filter(Boolean).length;
  if (types < 2) {
    return NextResponse.json(
      { error: "新密码至少包含两种：数字、字母、特殊符号" },
      { status: 400 },
    );
  }

  // 验证恢复码（返回 user_id 或 null）
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const verifyClient = createAdminClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: uid, error: verifyErr } = await verifyClient.rpc(
    "verify_recovery_code",
    { p_email: email, p_code: code },
  );
  if (verifyErr) {
    return NextResponse.json({ error: "校验失败，请重试" }, { status: 400 });
  }
  if (!uid) {
    return NextResponse.json(
      { error: "邮箱或恢复码不正确，或该账号尚未设置恢复码" },
      { status: 400 },
    );
  }

  if (!serviceKey) {
    // 不向客户端暴露具体缺失哪个环境变量（内部部署细节）
    return NextResponse.json(
      { error: "找回服务暂时不可用，请联系管理员重置密码。" },
      { status: 500 },
    );
  }

  const admin = createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: updateErr } = await admin.auth.admin.updateUserById(uid as string, {
    password: newPassword,
  });
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
