import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

type Body = {
  email?: string;
  confirmEmail?: string;
};

/**
 * 管理员删除账号（替用户注销）。
 *
 * 复用自服务注销 /auth/delete-account 的级联逻辑：
 *   1) 先把他「拥有且还有别人」的空间转让给最早加入的成员（优先 admin）；
 *   2) 仅其一人拥有的空间直接删除（级联清待办/邀请/成员）；
 *   3) 最后删除 auth.users，其余引用由 RLS/外键 CASCADE 清理。
 *
 * 安全护栏：禁止删除自己、禁止删除其他管理员（避免锁死后台）。
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "缺少 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" }, { status: 500 });
  }
  if (!serviceKey) {
    return NextResponse.json({ error: "删除服务暂时不可用，请联系系统运维。" }, { status: 500 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效请求" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const confirmEmail = (body.confirmEmail ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }
  if (confirmEmail !== email) {
    return NextResponse.json({ error: "确认邮箱与目标邮箱不一致" }, { status: 400 });
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

  const limited = rateLimit(`admindelete:${clientIp(request)}`, 10, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: `操作过于频繁，请 ${limited.retryAfterSec} 秒后再试` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } },
    );
  }

  const { data: target, error: targetErr } = (await admin
    .from("profiles")
    .select("id, is_admin")
    .eq("email", email)
    .single()) as {
    data: { id: string; is_admin: boolean } | null;
    error: unknown;
  };
  if (targetErr || !target) {
    return NextResponse.json({ error: "目标邮箱不存在" }, { status: 400 });
  }
  if (target.id === user.id) {
    return NextResponse.json({ error: "不能删除自己" }, { status: 400 });
  }
  if (target.is_admin) {
    return NextResponse.json({ error: "不能删除其他管理员" }, { status: 400 });
  }

  // —— 级联：先转让有人的空间，再删无主空间，最后删用户 ——
  const { data: ownedRows } = (await admin
    .from("spaces")
    .select("id")
    .eq("owner_id", target.id)) as { data: { id: string }[] | null; error: unknown };
  const ownedIds = (ownedRows ?? []).map((r) => r.id);

  const transferTargets = new Map<string, string>();
  if (ownedIds.length > 0) {
    const { data: memRows } = (await admin
      .from("space_members")
      .select("space_id, user_id, role, joined_at")
      .in("space_id", ownedIds)
      .neq("user_id", target.id)
      .order("joined_at", { ascending: true })) as {
      data: { space_id: string; user_id: string; role: string; joined_at: string }[] | null;
      error: unknown;
    };
    for (const m of memRows ?? []) {
      const sid = m.space_id;
      if (transferTargets.has(sid)) continue;
      if (m.role === "admin") transferTargets.set(sid, m.user_id);
      else if (!transferTargets.has(sid)) transferTargets.set(sid, m.user_id);
    }
  }

  for (const [spaceId, newOwnerId] of transferTargets) {
    const { error } = await admin
      .from("spaces")
      .update({ owner_id: newOwnerId })
      .eq("id", spaceId)
      .eq("owner_id", target.id);
    if (error) {
      return NextResponse.json(
        { error: `转让空间失败，已中止删除：${(error as Error).message}` },
        { status: 500 },
      );
    }
    await admin
      .from("space_members")
      .update({ role: "owner" })
      .eq("space_id", spaceId)
      .eq("user_id", newOwnerId);
  }

  const deleteIds = ownedIds.filter((id) => !transferTargets.has(id));
  if (deleteIds.length > 0) {
    const { error } = await admin.from("spaces").delete().in("id", deleteIds);
    if (error) {
      return NextResponse.json(
        { error: `清理个人空间失败，已中止删除：${(error as Error).message}` },
        { status: 500 },
      );
    }
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(target.id);
  if (delErr) {
    return NextResponse.json({ error: `删除失败：${(delErr as Error).message}` }, { status: 500 });
  }

  const { error: auditErr } = await admin.rpc("log_admin_action", {
    p_actor_id: user.id,
    p_action: "admin_delete_user",
    p_target_type: "user",
    p_target_id: target.id,
    p_detail: {
      email,
      transfer_spaces: transferTargets.size,
      delete_spaces: deleteIds.length,
    },
  });
  if (auditErr) console.error("[admin-delete] audit failed:", (auditErr as Error).message);

  return NextResponse.json({
    ok: true,
    transferSpaces: transferTargets.size,
    deleteSpaces: deleteIds.length,
  });
}
