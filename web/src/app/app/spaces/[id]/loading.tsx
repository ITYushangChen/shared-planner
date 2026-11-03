/**
 * 空间页加载骨架：导航期间立即占位，避免「旧页面冻一下再整段替换」的卡顿感。
 * 结构对齐 SpaceManageChrome 的顶栏 + 日历主区。
 */
export default function SpaceLoading() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1000px] flex-1 flex-col">
      {/* 顶栏：左 人员筛选占位 · 右 视图切换占位 */}
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-muted)] px-4 py-3">
        <div className="h-8 w-32 animate-pulse rounded-lg bg-[var(--surface-muted)]" />
        <div className="ml-auto flex items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-[var(--surface-muted)] p-1">
            {["日", "周", "月"].map((d) => (
              <div
                key={d}
                className="h-7 w-12 animate-pulse rounded-md bg-white/70"
              />
            ))}
          </div>
          <div className="flex gap-1 rounded-lg bg-[var(--surface-muted)] p-1">
            {["看板", "日历", "待办"].map((v) => (
              <div
                key={v}
                className="h-7 w-12 animate-pulse rounded-md bg-white/70"
              />
            ))}
          </div>
        </div>
      </header>
      {/* 日历主区骨架 */}
      <div
        className="grid w-full flex-1 grid-cols-7 gap-2 p-4"
        aria-busy="true"
        aria-label="加载空间内容中"
      >
        {Array.from({ length: 28 }).map((_, i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-lg bg-[var(--surface-muted)]"
          />
        ))}
      </div>
    </div>
  );
}
