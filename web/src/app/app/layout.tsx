import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAppAuth } from "@/lib/app-data";
import { AppSidebarSlot } from "./app-sidebar-slot";
import { DeferredNotificationToast } from "./deferred-notification-toast";
import { SidebarSkeleton } from "./sidebar-skeleton";
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
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col bg-white/92 backdrop-blur-md pb-[calc(4rem+env(safe-area-inset-bottom))] pt-[calc(3rem+env(safe-area-inset-top))] md:pb-0 md:pt-0">
        <DeferredNotificationToast />
        {/* 全站主体统一宽度：居中定宽，避免超宽屏下内容无限拉伸 */}
        <div className="mx-auto flex w-full min-w-0 max-w-[1200px] flex-1 flex-col">
          {children}
        </div>
      </div>
    </UiPrefsProvider>
  );
}
