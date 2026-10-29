/**
 * 导航加速开关（NEXT_PUBLIC_ 变量在构建期内联，改完需重启 `next dev` / 重新 build）。
 *
 * - FAST_SPACE_NAV = false → 恢复空间页「服务端拉齐待办 + 成员」旧行为
 * - true：日历 / 任务总览 / 待办列表均先出壳，客户端补数据
 *
 * 用法：.env.local 里设 NEXT_PUBLIC_FAST_SPACE_NAV=false 后重新构建；
 * 未设置时默认开启（true）。
 */
export const FAST_SPACE_NAV =
  process.env.NEXT_PUBLIC_FAST_SPACE_NAV !== "false";
