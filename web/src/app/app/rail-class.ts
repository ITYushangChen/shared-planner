/**
 * 最左图标栏（rail）统一视觉。
 *
 * 颜色全部取自 globals.css 的 --rail-* 变量：
 * 之前各处直接写死 text-white / hover:bg-white/15，
 * 一旦底色改成浅色（--rail-bg #e6f1fb），图标与文字立刻不可见。
 * 新增 rail 按钮请复用这里，不要自己写 text-white。
 */

/** 图标栏单个按钮：激活 = 白卡 + 品牌色字；未激活 = 深灰，悬停变白卡 */
export function railItemClass(active: boolean) {
  return [
    // rail-item 挂在 globals.css 里：统一图标 20px/线宽 1.7，并提供 data-tip 气泡
    "rail-item flex h-11 w-14 shrink-0 items-center justify-center rounded-xl border text-[var(--rail-fg)] transition-colors duration-200",
    active
      ? "border-[var(--rail-divider)] bg-[var(--rail-active-bg)] font-medium text-[var(--rail-active-fg)]"
      : "border-transparent hover:bg-[var(--rail-hover-bg)] hover:text-[var(--rail-fg-strong)]",
  ].join(" ");
}

/** 图标栏分组分隔线（浅底上必须用深一号的颜色，白色分隔线会消失） */
export const railDividerClass = "my-1 h-px w-9 shrink-0 bg-[var(--rail-divider)]";

/** 图标栏容器（z-40：让 data-tip 气泡能盖到右侧空间栏上面） */
export const railShellClass =
  "relative z-40 hidden h-dvh w-20 shrink-0 sticky top-0 flex-col items-center gap-1.5 bg-[var(--rail-bg)]/80 py-3 backdrop-blur-md md:flex";
