/**
 * 侧栏软导航：用 App Router 客户端跳转，复用 /app layout，避免整页重载。
 *
 * ⚠️ 性能教训（2026-11-02）：
 * 这里**不要**在挂载时批量预取所有空间路由 / 暖热所有空间数据。
 * Next 的 RSC 预取请求每一个都要在服务端跑一遍 middleware（登录校验），
 * 而 middleware 的 getUser() 是一次真实的 Supabase 往返。
 * 侧栏有 16 个空间时，进一次 /app 会产生 29 个 RSC 预取 + 32 个数据预取，
 * 单进程的 Node 要排队处理几秒，用户这时点空间就卡在队尾 —— 表现为「点一下要 5 秒」。
 *
 * 现在的策略：
 * - 只预取 3 个固定入口路由（量小、稳定）；
 * - 空间路由与空间数据改为**按需**：鼠标悬停 / 触摸按下时才预取那一个
 *   （见 space-nav-row.tsx 的 prefetchSpace）。
 */

const PREFETCH_HREFS = [
  "/app?view=calendar&range=week",
  "/app/notifications",
  "/app/profile",
] as const;

export function prefetchAppRoutes(
  prefetch: (href: string) => void,
  // 保留参数以兼容调用方；空间路由不再批量预取（原因见文件头注释）
  _spaceIds: string[] = [],
) {
  for (const href of PREFETCH_HREFS) {
    try {
      prefetch(href);
    } catch {
      // ignore
    }
  }
}
