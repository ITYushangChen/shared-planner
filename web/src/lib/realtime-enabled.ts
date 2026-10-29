/**
 * Realtime 总开关。
 *
 * 设为 "false"（即 .env.local 里 NEXT_PUBLIC_ENABLE_REALTIME=false 后重新构建）
 * 时，前端不会建立任何 Realtime WebSocket 连接。
 *
 * 用途：精简自托管 Supabase 时关闭了 Realtime 服务，这里优雅降级——
 * 不订阅、不报错、不影响登录与正常的增删改查（只是多人协作的「实时秒同步」
 * 退化为手动刷新/重新进入页面）。
 *
 * 注意：NEXT_PUBLIC_ 前缀的变量在构建期被内联，改它必须重新 `next build`。
 */
export const REALTIME_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_REALTIME !== "false";
