import { createServerClient } from "@supabase/ssr";
import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { mapAuthError } from "@/lib/error-map";

type Body = {
  email?: string;
  password?: string;
  displayName?: string;
  mode?: "signin" | "signup";
};

type CookieItem = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

/**
 * 服务端邮箱登录/注册，把 session 写到响应 Set-Cookie。
 * 经 Cloudflare 隧道时比纯浏览器端 signIn 更稳（避免进 /app 被中间件踢回登录）。
 * 注册成功时额外生成「一次性密码找回码」并通过响应体回传（仅展示一次）。
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.json(
      { error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" },
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
  const password = body.password ?? "";
  const mode = body.mode === "signup" ? "signup" : "signin";
  const displayName =
    body.displayName?.trim() || email.split("@")[0] || "User";

  if (!email || !password) {
    return NextResponse.json({ error: "请填写邮箱和密码" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "密码至少 6 位" }, { status: 400 });
  }
  // 邮箱格式（前端 type=email 只是提示，可被绕过）
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }

  // ⚠️ 安全：登录/注册接口此前无任何限流，可被脚本化撞库（无 CSRF token 的裸 JSON POST）。
  // 登录按 IP+邮箱限（防针对单账号爆破），注册按 IP 限（防批量注册）。
  const ip = clientIp(request);
  const emailKey = email.toLowerCase();
  const limit =
    mode === "signup"
      ? rateLimit(`signup:${ip}`, 5, 60 * 60 * 1000)
      : rateLimit(`signin:${ip}:${emailKey}`, 8, 5 * 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: `操作过于频繁，请 ${limit.retryAfterSec} 秒后再试`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const setCookies: CookieItem[] = [];

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          setCookies.push({ name, value, options });
        });
      },
    },
  });

  let payload: { ok: boolean; recoveryCode?: string; error?: string } = {
    ok: true,
  };

  if (mode === "signup") {
    const origin = request.nextUrl.origin;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/app?view=calendar&range=week")}`,
      },
    });
    if (error) {
      return NextResponse.json({ error: mapAuthError(error) }, { status: 400 });
    }
    if (!data.session) {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        return NextResponse.json(
          {
            error:
              "注册成功，但尚未建立登录会话。请到 Supabase 关闭 Confirm email 后点登录。",
          },
          { status: 400 },
        );
      }
    }
    // 生成一次性找回码：明文仅在此回传一次，库内存哈希
    if (data.user?.id) {
      const recoveryCode = randomBytes(8).toString("hex");
      try {
        await supabase.rpc("set_recovery_code", {
          p_user_id: data.user.id,
          p_code: recoveryCode,
        });
        payload.recoveryCode = recoveryCode;
      } catch {
        // 找回码写入失败不阻断注册；用户可在设置里重生成
      }
    }
  } else {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      return NextResponse.json({ error: mapAuthError(error) }, { status: 401 });
    }
  }

  try {
    await supabase.rpc("ensure_my_bootstrap");
  } catch {
    // 建档失败不阻断登录
  }

  const isHttps = request.nextUrl.protocol === "https:";
  const res = NextResponse.json(payload);
  for (const c of setCookies) {
    res.cookies.set(c.name, c.value, {
      ...c.options,
      path: (c.options?.path as string) ?? "/",
      sameSite: (c.options?.sameSite as "lax" | "strict" | "none") ?? "lax",
      // localhost(http) 不能 Secure；隧道 https 必须 Secure
      secure: isHttps ? true : Boolean(c.options?.secure),
    });
  }
  return res;
}
