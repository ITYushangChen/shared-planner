import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = {
  /** 不传 = 只预览影响面；传了且等于当前账号邮箱 = 真正执行 */
  confirmEmail?: string;
};

type Impact = {
  /** 我创建的待办总数（删除账号时会被级联删除，含他人空间里的） */
  createdTodos: number;
  /** 涉及的空间数（不含我自己的空间） */
  otherSpaces: number;
  /** 我拥有的空间数 */
  ownedSpaces: number;
  /** 其中将转让给他人的空间数 */
  transferSpaces: number;
  /** 其中将一并删除的空间数（只有我一个成员） */
  deleteSpaces: number;
};

/**
 * 注销账号。
 *
 * 危险操作，因此设计成两步：
 *   1. 不传 confirmEmail → 只返回影响面（会被删多少、转让多少），供 UI 展示
 *   2. 传 confirmEmail 且等于当前账号邮箱 → 真正执行
 *
 * 数据库级联行为（见迁移 20261029000000_profile_fk_cascade）：
 * 引用 profiles 的 NOT NULL 列都是 ON DELETE CASCADE，所以删除 auth.users 会连带删掉
 *   该用户创建的待办（**含在他人空间里创建的**）、评论、AI 记录、成员身份，
 *   以及他拥有（owner_id）的空间。因此执行前必须先把还有别人的空间转让出去，
 *   否则别人的协作空间会被一起端掉。
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "服务端配置不完整" }, { status: 500 });
  }

  // 1) 用请求自带的 cookie 建立会话客户端，确认「是谁在请求」
  const setCookies: { name: string; value: string; options: unknown }[] = [];
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        setCookies.length = 0;
        for (const c of list) setCookies.push(c as never);
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "登录状态已失效，请重新登录" }, { status: 401 });
  }
  if (!user.email) {
    return NextResponse.json({ error: "账号没有绑定邮箱，无法注销" }, { status: 400 });
  }

  // ⚠️ 注销是重操作，按用户限流，避免被脚本反复打
  const limited = rateLimit(`delete-account:${user.id}`, 5, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: `操作过于频繁，请 ${limited.retryAfterSec} 秒后再试` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } },
    );
  }

  // 2) 统计影响面（用当前会话读，RLS 保证只能读到自己的）
  const [createdRes, ownedRes] = await Promise.all([
    supabase.from("todos").select("id, space_id", { count: "exact", head: true }).eq("creator_id", user.id),
    supabase.from("spaces").select("id", { count: "exact", head: true }).eq("owner_id", user.id),
  ]);

  // 我创建的待办落在多少个「不是我拥有」的空间里
  const memberRes = await supabase
    .from("space_members")
    .select("space_id")
    .eq("user_id", user.id);
  const mySpaceIds = new Set((memberRes.data ?? []).map((m) => m.space_id as string));

  // 我拥有的空间里，还有多少是有其他成员的（需要转让）
  const ownedIds: string[] = [];
  if (ownedRes.count && ownedRes.count > 0) {
    const { data: ownedRows } = await supabase
      .from("spaces")
      .select("id")
      .eq("owner_id", user.id);
    ownedIds.push(...(ownedRows ?? []).map((r) => r.id as string));
  }
  let transferSpaces = 0;
  const transferTargets = new Map<string, string>();
  if (ownedIds.length > 0) {
    const { data: memRows } = await supabase
      .from("space_members")
      .select("space_id, user_id, role, joined_at")
      .in("space_id", ownedIds)
      .neq("user_id", user.id)
      .order("joined_at", { ascending: true });
    for (const m of memRows ?? []) {
      const sid = m.space_id as string;
      if (transferTargets.has(sid)) continue;
      // 优先 admin，其次最早加入的 member
      if ((m.role as string) === "admin") transferTargets.set(sid, m.user_id as string);
      else if (!transferTargets.has(sid)) transferTargets.set(sid, m.user_id as string);
    }
    transferSpaces = transferTargets.size;
  }

  const impact: Impact = {
    createdTodos: createdRes.count ?? 0,
    otherSpaces: Math.max(0, mySpaceIds.size - ownedIds.length),
    ownedSpaces: ownedIds.length,
    transferSpaces,
    deleteSpaces: ownedIds.length - transferSpaces,
  };

  // 预览模式：只返回影响面
  const confirmEmail = (await request.json().catch(() => ({})) as Body)
    .confirmEmail?.trim()
    .toLowerCase();
  if (!confirmEmail) {
    return NextResponse.json({ impact, email: user.email });
  }
  if (confirmEmail !== user.email.toLowerCase()) {
    return NextResponse.json({ error: "邮箱与当前账号不一致" }, { status: 400 });
  }

  if (!serviceKey) {
    return NextResponse.json(
      { error: "注销服务暂时不可用，请联系管理员处理。" },
      { status: 500 },
    );
  }

  const admin = createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 3) 先把有别人的空间转让出去，再删用户（否则会级联删掉整个协作空间）
  for (const [spaceId, newOwnerId] of transferTargets) {
    const { error } = await admin
      .from("spaces")
      .update({ owner_id: newOwnerId })
      .eq("id", spaceId)
      .eq("owner_id", user.id);
    if (error) {
      return NextResponse.json(
        { error: `转让空间失败，已中止注销：${error.message}` },
        { status: 500 },
      );
    }
    // 新 owner 在 space_members 里的角色也要跟着升
    await admin
      .from("space_members")
      .update({ role: "owner" })
      .eq("space_id", spaceId)
      .eq("user_id", newOwnerId);
  }

  // 4) 只剩我一个人的空间：显式删除（级联清待办/邀请/成员），避免留下无主空间
  const deleteIds = ownedIds.filter((id) => !transferTargets.has(id));
  if (deleteIds.length > 0) {
    const { error } = await admin.from("spaces").delete().in("id", deleteIds);
    if (error) {
      return NextResponse.json(
        { error: `清理个人空间失败，已中止注销：${error.message}` },
        { status: 500 },
      );
    }
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    return NextResponse.json(
      { error: `注销失败：${delErr.message}` },
      { status: 500 },
    );
  }

  const res = NextResponse.json({ ok: true, impact });
  // 清掉会话 cookie，避免前端再拿已失效的 token 去请求
  for (const c of setCookies) {
    if (!c.value) res.cookies.set(c.name, "", { maxAge: 0, path: "/" });
  }
  res.cookies.set("sb-access-token", "", { maxAge: 0, path: "/" });
  res.cookies.set("sb-refresh-token", "", { maxAge: 0, path: "/" });
  return res;
}
