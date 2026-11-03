import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectTarget } from "@/lib/safe-redirect";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // ⚠️ 安全：next 来自 query，必须过白名单。
  // 直接 `${origin}${next}` 拼接时，`next=@evil.com/` 会让 origin 的主机名
  // 退化成 URL userinfo，真实 host 变成 evil.com（开放重定向）。
  const next = safeRedirectTarget(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
