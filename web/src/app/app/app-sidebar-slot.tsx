import {
  getAppAuth,
  getMySpaceNav,
  mapMembershipRows,
  visibleSpaceNav,
} from "@/lib/app-data";
import { BottomNav } from "./bottom-nav";
import { HydrateSpacePrefs } from "./hydrate-space-prefs";

const SPACE_SELECT =
  "role, ui_prefs, spaces(id, name, kind, visibility, avatar_url, description)";

/**
 * App 外壳数据加载器（原 AppSidebarSlot，左侧栏已移除）：
 * 流式拉取空间列表 → 水合各空间 ui_prefs + 渲染底部导航。
 * 不阻塞主内容 RSC。
 */
export async function AppShellSlot() {
  const { supabase, user } = await getAppAuth();
  if (!user) return null;

  let spaceNav = await getMySpaceNav();
  let spaces = spaceNav.spaces;
  let spacePrefsById = spaceNav.spacePrefsById;

  if (spaces.length === 0) {
    await supabase.rpc("ensure_my_bootstrap");
    const { data: memberships } = await supabase
      .from("space_members")
      .select(SPACE_SELECT)
      .eq("user_id", user.id)
      .order("joined_at", { ascending: true });
    const mapped = mapMembershipRows(memberships ?? []);
    spaces = mapped.spaces;
    spacePrefsById = mapped.spacePrefsById;
  }

  const navSpaces = visibleSpaceNav(spaces);

  return (
    <>
      <HydrateSpacePrefs spacePrefsByIdRaw={spacePrefsById} />
      <BottomNav spaces={navSpaces} />
    </>
  );
}
