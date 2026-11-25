import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return supabaseResponse;
  }

  // ⚠️ 性能关键点（2026-11-02）：客户端软导航（router.push / Link / 预取）发出的是
  // **RSC 请求**，它同样会命中这个 middleware。而下面的 getUser() 是一次真实的
  // Supabase 网络往返：线上 Next 与 Supabase 同机（loopback，几毫秒），但本地预览
  // 时就是一次跨境请求（300ms+），再加上 16 个空间链接的预取，单进程排队几秒，
  // 用户点空间时 URL 要等到 RSC 回来才变 —— 表现就是「点一下卡 5 秒」。
  //
  // RSC 请求不需要在这里做门禁：
  // - 空间页已是客户端组件，RSC 载荷里没有任何用户数据，数据全部走浏览器端
  //   Supabase 请求，由 RLS 按登录用户鉴权；
  // - 其余服务端页面各自在渲染时校验（getAppAuth / RLS），不依赖 middleware 兜底。
  // 所以这里只对「整页加载」做登录门禁，RSC / 预取请求直接放行。
  //
  // ⚠️ 安全修正（2026-11-02）：原实现只判断 `rsc: 1` / `next-router-prefetch: 1`
  // 这两个自定义头，而它们是**普通请求头，页面里的 JS 或一行 curl 都能伪造**，
  // 等于这道门禁形同虚设。
  // 改用 `sec-fetch-dest`：它是 Forbidden Header Name，浏览器只允许自己设置，
  // 页面 JS 无法覆盖（curl 能伪造，但 curl 拿不到任何用户数据 —— 下面说明）。
  //   - `document`   = 整页导航 → 做登录门禁（URL 直接暴露，必须拦）
  //   - `empty`      = 浏览器发出的 fetch/XHR，即 RSC 与路由预取 → 放行
  //   - 缺失         = 非浏览器客户端（curl / 老浏览器）→ 保守做门禁
  // 放行的安全性由 RLS 保证：空间页是客户端组件，RSC 载荷不含用户数据，
  // 所有数据都在浏览器端经 Supabase 请求、由 RLS 按登录用户鉴权。
  const fetchDest = request.headers.get("sec-fetch-dest");
  if (fetchDest && fetchDest !== "document") {
    return NextResponse.next();
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // 注意：这里必须用 getUser()。@supabase/ssr 在 middleware 里靠它顺带完成
  // access token 刷新并回写 cookie，换成 getSession() 会丢掉自动续期。
  // 线上 Next 与 Supabase 同机部署，这一跳是 loopback（几毫秒），不值得省。
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // 封禁拦截：已登录且被封禁的用户，清掉会话 cookie 并跳到 /banned。
  // 注意 fail-open：is_user_banned 调用异常时一律放行，绝不让一个 RPC 故障锁死全站。
  if (user) {
    let banned = false;
    try {
      const { data } = await supabase.rpc("is_user_banned", { p_user_id: user.id });
      banned = Boolean(data);
    } catch {
      banned = false;
    }
    if (banned) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/banned";
      const res = NextResponse.redirect(redirectUrl);
      for (const c of request.cookies.getAll()) {
        res.cookies.set(c.name, "", { maxAge: 0, path: "/" });
      }
      return res;
    }
  }

  const path = request.nextUrl.pathname;
  const isLogin = path === "/login";
  const isApp = path === "/app" || path.startsWith("/app/");
  const isAuthCallback = path.startsWith("/auth/");

  if (!user && isApp) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", path);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && isLogin) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/app";
    redirectUrl.search = "view=calendar&range=week";
    return NextResponse.redirect(redirectUrl);
  }

  if (isAuthCallback) {
    return supabaseResponse;
  }

  // ⚠️ 页面 HTML 一律 no-store（2026-11-24）：整页加载必须拿到最新 HTML，
  // 才能引用到最新的 content-hash chunk。此前页面 HTML 没有任何缓存头，
  // 浏览器（尤其微信 WebView）会 heuristic 缓存旧 HTML，导致「改了代码但手机
  // 仍显示旧界面」。RSC / 路由预取请求在上面已提前 return，不受影响。
  supabaseResponse.headers.set(
    "Cache-Control",
    "no-store, max-age=0, must-revalidate",
  );

  return supabaseResponse;
}

export const config = {
  // 仅鉴权相关路径，避免全站 getUser
  matcher: ["/app", "/app/:path*", "/login", "/auth/:path*"],
};
