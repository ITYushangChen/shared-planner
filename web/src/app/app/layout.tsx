import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAppAuth } from "@/lib/app-data";
import { AppShellSlot } from "./app-sidebar-slot";
import { DeferredNotificationToast } from "./deferred-notification-toast";
import { NavSkeleton } from "./sidebar-skeleton";
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

  // 只等轻量 profile，空间列表与主内容并行流式
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
      {/* 白幕不能让背景图变成纯白：0.92→0.78、模糊 12px→6px，让 bgImageUrl 能透出来 */}
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col bg-white/[0.78] backdrop-blur-[6px]">
        <Suspense fallback={<TopBarSkeleton />}>
          <TopBar />
        </Suspense>
        <DeferredNotificationToast />
        {/* 全站主体统一宽度：居中定宽，避免超宽屏下内容无限拉伸 */}
        {/* 底部留白容纳悬浮＋底栏；桌面同样保留，因为底栏全尺寸常驻 */}
        <div className="mx-auto flex w-full min-w-0 max-w-[1200px] flex-1 flex-col pb-[calc(5rem+env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
      <Suspense fallback={<NavSkeleton />}>
        <AppShellSlot />
      </Suspense>
    </UiPrefsProvider>
  );
}

/** 顶栏骨架：与 TopBar 同高，避免 useSearchParams 水合期间的布局跳动 */
function TopBarSkeleton() {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border-muted)] bg-white/90">
      <div className="mx-auto flex h-12 w-full max-w-[1200px] items-center justify-between px-4 md:px-6">
        <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
        <div className="h-6 w-6 animate-pulse rounded-full bg-zinc-200" />
      </div>
    </header>
  );
}
