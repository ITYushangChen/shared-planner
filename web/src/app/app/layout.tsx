import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAppAuth } from "@/lib/app-data";
import { AppSidebarSlot } from "./app-sidebar-slot";
import { DeferredNotificationToast } from "./deferred-notification-toast";
import { SidebarSkeleton, TopBarSkeleton } from "./sidebar-skeleton";
import { TopBar } from "./top-bar";
import { UiPrefsProvider } from "./ui-prefs-provider";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { supabase, user } = await getAppAuth();

  if (!user) {
    redirect("/login");
  }

  // 只等轻量 profile，侧栏空间列表与主内容并行流式
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, avatar_url, timezone, ui_prefs")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <UiPrefsProvider
      globalPrefsRaw={profile?.ui_prefs}
      spacePrefsByIdRaw={{}}
    >
      <Suspense fallback={<SidebarSkeleton />}>
        <AppSidebarSlot profile={profile} />
      </Suspense>
      {/* 白幕不能让背景图变成纯白：0.92→0.78、模糊 12px→6px，让 bgImageUrl 能透出来 */}
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col bg-white/[0.78] backdrop-blur-[6px]">
        {/* 移动端顶栏：sticky 占位（桌面 md:hidden） */}
        <Suspense fallback={<TopBarSkeleton />}>
          <TopBar />
        </Suspense>
        <DeferredNotificationToast />
        {/* 全站主体统一宽度：居中定宽，避免超宽屏下内容无限拉伸 */}
        {/* 底部留白容纳移动底栏（含悬浮＋）；桌面无底栏故 md:pb-0 */}
        <div className="mx-auto flex w-full min-w-0 max-w-[1200px] flex-1 flex-col pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </div>
      </div>
    </UiPrefsProvider>
  );
}
