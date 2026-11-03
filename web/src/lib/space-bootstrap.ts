import { createClient } from "@/lib/supabase/client";
import { getAuthUser } from "@/lib/auth-user";
import {
  setCachedSpaceMembers,
  type SpaceMemberRow,
} from "@/lib/space-data-cache";
import type { InviteRow } from "@/lib/invites";
import type { SpaceMemberOption } from "@/lib/todos";

/**
 * A + C 方案：空间首屏数据「一次取全量 + 内存缓存」。
 *
 * 之前点开空间要先串行查 4 次（我的角色 → 时区 → 成员 → 邀请），
 * 每次都是一轮跨境往返。现在由 `get_space_bootstrap` 数据库函数
 * 一次返回；结果再按 space_id 缓存在内存里，切回已看过的空间时
 * 立刻出内容，同时后台静默刷新（stale-while-revalidate）。
 */

export type SpaceHeader = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  owner_id: string;
  avatar_url: string | null;
  visibility: string | null;
};

export type SpaceBootstrap = {
  space: SpaceHeader;
  role: string;
  userId: string;
  timezone: string | null;
  memberOptions: SpaceMemberOption[];
  memberRows: SpaceMemberRow[];
  invites: InviteRow[];
  fetchedAt: number;
};

type RawMember = {
  user_id: string;
  role: string;
  display_name: string | null;
  email: string | null;
};

type RawResult = {
  ok: boolean;
  error?: string;
  user_id?: string;
  role?: string;
  timezone?: string | null;
  space?: SpaceHeader | null;
  members?: RawMember[] | null;
  invites?: InviteRow[] | null;
};

const bootstrapCache = new Map<string, SpaceBootstrap>();
const bootstrapInflight = new Map<string, Promise<SpaceBootstrap | null>>();

export function getCachedSpaceBootstrap(
  spaceId: string,
): SpaceBootstrap | null {
  return bootstrapCache.get(spaceId) ?? null;
}

function toBootstrap(raw: RawResult, spaceId: string): SpaceBootstrap | null {
  if (!raw.space || !raw.role || !raw.user_id) return null;
  const members = raw.members ?? [];
  const memberOptions: SpaceMemberOption[] = [];
  const memberRows: SpaceMemberRow[] = [];
  for (const m of members) {
    const display_name = m.display_name ?? "成员";
    memberOptions.push({
      user_id: m.user_id,
      display_name,
      email: m.email ?? null,
    });
    memberRows.push({
      user_id: m.user_id,
      role: m.role,
      display_name,
      email: m.email ?? null,
    });
  }
  return {
    space: { ...raw.space, id: raw.space.id ?? spaceId },
    role: raw.role,
    userId: raw.user_id,
    timezone: raw.timezone ?? null,
    memberOptions,
    memberRows,
    invites: (raw.invites ?? []) as InviteRow[],
    fetchedAt: Date.now(),
  };
}

/**
 * 降级路径：数据库还没执行 20261102030000 的 RPC 时（例如刚部署、迁移未跑），
 * 退回原来的多次查询。保证「代码先上线、迁移后补」也不会白屏。
 */
async function legacyFetch(spaceId: string): Promise<SpaceBootstrap | null> {
  const supabase = createClient();
  const user = await getAuthUser();
  if (!user) return null;

  const [memRes, profRes, membersRes, invitesRes] = await Promise.all([
    supabase
      .from("space_members")
      .select(
        "role, spaces(id, name, description, kind, owner_id, avatar_url, visibility)",
      )
      .eq("space_id", spaceId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("profiles").select("timezone").eq("id", user.id).maybeSingle(),
    supabase
      .from("space_members")
      .select("user_id, role, profiles(display_name, email)")
      .eq("space_id", spaceId),
    supabase
      .from("space_invitations")
      .select(
        "id, code, invite_type, max_uses, used_count, expires_at, status, created_at",
      )
      .eq("space_id", spaceId)
      .order("created_at", { ascending: false }),
  ]);

  const membership = memRes.data as unknown as
    | { role: string; spaces: SpaceHeader | null }
    | null;
  if (!membership || !membership.spaces) return null;

  const memberOptions: SpaceMemberOption[] = [];
  const memberRows: SpaceMemberRow[] = [];
  for (const m of (membersRes.data ?? []) as unknown as RawMember[]) {
    const raw = (m as unknown as { profiles: unknown }).profiles;
    const prof = (Array.isArray(raw) ? raw[0] : raw) as {
      display_name: string | null;
      email: string | null;
    } | null;
    const display_name = prof?.display_name ?? "成员";
    const email = prof?.email ?? null;
    memberOptions.push({ user_id: m.user_id, display_name, email });
    memberRows.push({ user_id: m.user_id, role: m.role, display_name, email });
  }

  return {
    space: membership.spaces,
    role: membership.role,
    userId: user.id,
    timezone: (profRes.data as { timezone: string | null } | null)?.timezone ?? null,
    memberOptions,
    memberRows,
    invites: (invitesRes.data ?? []) as unknown as InviteRow[],
    fetchedAt: Date.now(),
  };
}

function fetchBootstrap(spaceId: string): Promise<SpaceBootstrap | null> {
  const existing = bootstrapInflight.get(spaceId);
  if (existing) return existing;

  const promise = (async () => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("get_space_bootstrap", {
      p_space_id: spaceId,
    });
    let result: SpaceBootstrap | null = null;

    if (!error) {
      const raw = data as RawResult | null;
      if (raw && raw.ok) result = toBootstrap(raw, spaceId);
      else if (raw && raw.error === "forbidden") return null;
    }

    // RPC 不可用（迁移未执行 / 网络异常）→ 退回旧路径
    if (!result) result = await legacyFetch(spaceId);
    if (!result) return null;

    bootstrapCache.set(spaceId, result);
    // 让 SpaceManageChrome / SpaceWorkspace 直接复用，别再查一次成员
    setCachedSpaceMembers(spaceId, {
      options: result.memberOptions,
      rows: result.memberRows,
    });
    return result;
  })().finally(() => {
    bootstrapInflight.delete(spaceId);
  });

  bootstrapInflight.set(spaceId, promise);
  return promise;
}

/** hover / 侧栏预取：不阻塞 UI，失败静默 */
export function prefetchSpaceBootstrap(spaceId: string) {
  if (bootstrapCache.has(spaceId) || bootstrapInflight.has(spaceId)) return;
  void fetchBootstrap(spaceId);
}

/**
 * 读空间首屏数据。有缓存立刻 onData（秒开），随后后台刷新再 onData 一次。
 * 空间不存在 / 无权限 / 未登录 → 返回 null。
 */
export function loadSpaceBootstrap(
  spaceId: string,
  opts?: { onData?: (data: SpaceBootstrap) => void },
): Promise<SpaceBootstrap | null> {
  const cached = bootstrapCache.get(spaceId);
  if (cached) {
    opts?.onData?.(cached);
    void fetchBootstrap(spaceId).then((fresh) => {
      if (fresh) opts?.onData?.(fresh);
    });
    return Promise.resolve(cached);
  }
  return fetchBootstrap(spaceId).then((data) => {
    if (data) opts?.onData?.(data);
    return data;
  });
}

/** 空间设置改动后让缓存失效 */
export function invalidateSpaceBootstrap(spaceId: string) {
  bootstrapCache.delete(spaceId);
}
