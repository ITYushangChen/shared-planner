"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * 面板形态：
 * - center：桌面居中卡片（默认）
 * - bottom：手机上从底部升起、桌面居中（快速创建）
 * - left：左侧滑出抽屉（移动端菜单）
 * - right：右侧滑出抽屉（AI 助手）
 */
export type ModalVariant = "center" | "bottom" | "left" | "right";

const OVERLAY_BASE: Record<ModalVariant, string> = {
  center: "flex items-center justify-center p-4",
  bottom: "flex items-end justify-center p-0 sm:items-center sm:p-4",
  left: "flex",
  right: "flex justify-end",
};

const PANEL_BASE: Record<ModalVariant, string> = {
  center:
    "w-full max-w-md rounded-2xl bg-white p-5 shadow-xl max-h-[90vh] overflow-y-auto",
  bottom:
    "w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl max-h-[90vh] overflow-y-auto sm:rounded-2xl",
  left: "absolute inset-y-0 left-0 flex w-[min(86vw,320px)] flex-col bg-white shadow-xl",
  right: "flex h-full w-full max-w-md flex-col bg-white shadow-2xl",
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** 读屏用的弹窗名称 */
  title: string;
  children: ReactNode;
  /** 面板形态，默认 center */
  variant?: ModalVariant;
  /**
   * 面板样式。**提供时整体替换**形态默认样式（不是追加）。
   *
   * Tailwind 同类冲突（如 max-w-md 与 max-w-lg 同时存在）由 CSS 源码顺序决定，
   * 结果不可预期——实测 max-w-2xl 会被默认的 max-w-md 压掉。
   * 因此这里「要改就整套给」，调用方把宽高/圆角/内边距写全即可，行为可预测。
   */
  className?: string;
  /** 遮罩额外样式；提供则替换形态默认的对齐/内边距 */
  overlayClassName?: string;
  /** 遮罩层级，默认 z-[100] */
  zClass?: string;
};

/**
 * 统一弹窗基建。
 *
 * 此前全站 0 个 `role="dialog"`：读屏用户听不出弹窗边界，Tab 能跑到背景内容上，
 * Esc 关不掉，打开后焦点也不进弹窗。这里一次性解决：
 *   - role="dialog" + aria-modal + aria-label
 *   - Esc 关闭
 *   - Tab 焦点陷阱（首尾循环）
 *   - 打开时自动聚焦第一个可聚焦控件，关闭后焦点归还触发元素
 *   - 打开期间锁定背景滚动
 *   - 点击遮罩关闭
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  variant = "center",
  className,
  overlayClassName,
  zClass = "z-[100]",
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // onClose 通常是内联箭头函数，每次父组件渲染都会变。
  // 若把它放进下方 effect 的依赖，父组件一重渲染就会 cleanup → 归还焦点 → 重新聚焦首个控件，
  // 用户在输入框里打字会被反复抢走光标。这里用 ref 取最新值，effect 只依赖 open。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!items || items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`fixed inset-0 ${zClass} bg-black/40 ${overlayClassName ?? OVERLAY_BASE[variant]}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`${className ?? PANEL_BASE[variant]} outline-none`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
