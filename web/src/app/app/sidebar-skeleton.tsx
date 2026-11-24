/** 底部导航占位：空间列表流式补上前先出壳子，避免底栏闪跳 */
export function NavSkeleton() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-muted)] bg-white/95">
      <div className="mx-auto grid h-16 w-full max-w-[1200px] grid-cols-5 px-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col items-center justify-center gap-1"
          >
            <div className="h-6 w-6 animate-pulse rounded-full bg-zinc-200" />
            <div className="h-2 w-8 animate-pulse rounded bg-zinc-200" />
          </div>
        ))}
      </div>
    </nav>
  );
}
