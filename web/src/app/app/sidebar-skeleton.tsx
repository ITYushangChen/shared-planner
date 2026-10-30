"use client";

import { usePathname } from "next/navigation";

/** 侧栏占位：壳子先出，空间列表流式补上 */
export function SidebarSkeleton() {
  const pathname = usePathname();
  /** 消息页不显示二级空间栏，占位也别闪它 */
  const onMessagesPage =
    pathname === "/app/notifications" ||
    pathname.startsWith("/app/notifications/");

  return (
    <>
      <aside className="hidden h-dvh w-28 shrink-0 flex-col items-center gap-1 bg-[var(--brand-rail)]/80 py-3 md:flex">
        <div className="mb-1 h-10 w-10 animate-pulse rounded-full bg-white/30" />
        <div className="h-12 w-16 animate-pulse rounded-xl bg-white/25" />
        <div className="h-12 w-16 animate-pulse rounded-xl bg-white/25" />
        <div className="h-12 w-16 animate-pulse rounded-xl bg-white/25" />
      </aside>
      {onMessagesPage ? null : (
        <aside className="hidden h-dvh w-64 shrink-0 flex-col border-r border-[var(--border-muted)] bg-[var(--surface-muted)]/80 md:flex">
          <div className="flex items-center gap-2 border-b border-[var(--border-muted)] px-3 py-3">
            <div className="h-9 w-9 animate-pulse rounded-full bg-zinc-200" />
            <div className="h-4 flex-1 animate-pulse rounded bg-zinc-200" />
          </div>
          <div className="flex flex-1 flex-col gap-2 p-3">
            <div className="h-8 animate-pulse rounded-lg bg-zinc-200/80" />
            <div className="mt-2 h-3 w-20 animate-pulse rounded bg-zinc-200/70" />
            <div className="h-9 animate-pulse rounded-lg bg-zinc-200/60" />
            <div className="h-9 animate-pulse rounded-lg bg-zinc-200/60" />
            <div className="h-9 animate-pulse rounded-lg bg-zinc-200/60" />
          </div>
        </aside>
      )}
      <div className="fixed inset-x-0 top-0 z-40 h-12 border-b border-[var(--border-muted)] bg-white/95 md:hidden">
        <div className="flex h-full items-center gap-2 px-3">
          <div className="h-8 w-8 animate-pulse rounded-lg bg-zinc-200" />
          <div className="h-4 flex-1 animate-pulse rounded bg-zinc-200" />
        </div>
      </div>
    </>
  );
}
