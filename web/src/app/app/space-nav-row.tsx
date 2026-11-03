"use client";

import { startTransition, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  prefetchSpaceCalendarTodos,
  prefetchSpaceMembers,
} from "@/lib/space-data-cache";
import { prefetchSpaceBootstrap } from "@/lib/space-bootstrap";
import { createClient } from "@/lib/supabase/client";
import { useViewTransition } from "@/lib/use-view-transition";
import { spaceKindLabel } from "@/lib/spaces";
import type { SpaceNavItem } from "@/lib/todos";

type Props = {
  space: SpaceNavItem;
  subtitle?: string;
  onQuickCreate?: (spaceId: string) => void;
  /** 点击进入空间后回调（如关闭移动端抽屉） */
  onNavigate?: () => void;
  /**
   * stacked：手机抽屉——标题同行 ··· / +，不显示 kind 副标题
   * inline：桌面侧栏——标题同行操作，下方显示 kind（个人空间/工作区等）
   */
  actionsPlacement?: "inline" | "stacked";
  /** 隐藏标题下的 kind 副标题（个人空间/工作区等） */
  hideSubtitle?: boolean;
};

function canManage(s: SpaceNavItem) {
  return s.role === "owner" || s.role === "admin";
}

export function SpaceNavRow({
  space,
  subtitle,
  onQuickCreate,
  onNavigate,
  actionsPlacement = "inline",
  hideSubtitle = false,
}: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const transitionTo = useViewTransition();
  const supabase = createClient();
  const href = `/app/spaces/${space.id}`;
  const routeActive = pathname === href || pathname.startsWith(`${href}/`);
  /** 点击后立刻高亮，等路由追上再交给 pathname */
  const [pendingActive, setPendingActive] = useState(false);
  const active = routeActive || pendingActive;
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const manage = canManage(space);
  const isOwner = space.role === "owner";
  const stacked = actionsPlacement === "stacked";
  const showSubtitle = !hideSubtitle && !stacked;

  useEffect(() => {
    setPendingActive(false);
  }, [pathname]);

  function prefetchSpace() {
    router.prefetch(href);
    // 空间首屏数据（空间/角色/成员/邀请）——hover 即预热，点下去基本秒开
    prefetchSpaceBootstrap(space.id);
    prefetchSpaceCalendarTodos(space.id);
    prefetchSpaceMembers(space.id);
  }

  // 普通左键点击走视图过渡跳转；带修饰键/中键则放行，交回浏览器原生的新标签打开。
  function handleNavClick(e: ReactMouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    setPendingActive(true);
    prefetchSpace();
    onNavigate?.();
    transitionTo(href);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  function goPanel(panel: "invites" | "members" | "settings" | "leave") {
    setMenuOpen(false);
    onNavigate?.();
    startTransition(() => {
      router.push(`${href}?panel=${panel}`);
    });
  }

  async function deleteSpace() {
    if (
      !confirm(
        `确定删除空间「${space.name}」？成员与待办将一并删除，且不可恢复。`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setMenuOpen(false);
    const { error } = await supabase.from("spaces").delete().eq("id", space.id);
    setDeleting(false);
    if (error) {
      alert(error.message || "删除失败（仅所有者可删除）");
      return;
    }
    onNavigate?.();
    startTransition(() => {
      router.push("/app?view=calendar&range=week");
      router.refresh();
    });
  }

  const iconBtn = stacked
    ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--brand-ink)]"
    : [
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-base transition-[opacity,color,background-color] duration-150 hover:bg-white hover:text-[var(--brand-ink)]",
        active
          ? "text-[var(--text-muted)] opacity-100"
          : "pointer-events-none text-[var(--text-muted)] opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
      ].join(" ");

  const menu = menuOpen ? (
    <div
      className={[
        "absolute z-50 w-36 overflow-hidden rounded-lg border border-[var(--border-muted)] bg-white py-1 shadow-lg",
        stacked ? "left-2 top-full mt-1" : "right-1 top-7",
      ].join(" ")}
    >
      {manage ? (
        <>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-sm text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
            onClick={() => goPanel("invites")}
          >
            邀请成员
          </button>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-sm text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
            onClick={() => goPanel("members")}
          >
            成员管理
          </button>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-sm text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
            onClick={() => goPanel("settings")}
          >
            空间设置
          </button>
          {isOwner ? (
            <button
              type="button"
              disabled={deleting}
              className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
              onClick={() => void deleteSpace()}
            >
              {deleting ? "删除中…" : "删除空间"}
            </button>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left text-sm text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
          onClick={() => goPanel("leave")}
        >
          离开空间
        </button>
      )}
    </div>
  ) : null;

  const moreBtn = (
    <button
      type="button"
      title="更多"
      aria-label="更多"
      className={iconBtn}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen((v) => !v);
      }}
    >
      ···
    </button>
  );

  const plusBtn = onQuickCreate ? (
    <button
      type="button"
      title="快速创建"
      aria-label="快速创建"
      className={iconBtn}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onQuickCreate(space.id);
      }}
    >
      +
    </button>
  ) : null;

  return (
    <div
      ref={rootRef}
      className={[
        "group relative rounded-r-lg border-l-[3px] py-1.5 pl-2 pr-1 text-[14px] transition-colors duration-200",
        active
          ? "border-brand bg-brand-soft font-medium text-brand"
          : "border-transparent text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-0.5">
        <Link
          href={href}
          prefetch={false}
          className={[
            "min-w-0 flex-1 truncate py-1",
            stacked ? "font-medium" : "",
          ].join(" ")}
          title={space.name}
          onMouseEnter={prefetchSpace}
          onFocus={prefetchSpace}
          onPointerDown={prefetchSpace}
          onClick={handleNavClick}
        >
          {space.name}
        </Link>
        {moreBtn}
        {plusBtn}
      </div>
      {showSubtitle ? (
        <Link
          href={href}
          prefetch={false}
          className="mt-0.5 block truncate text-xs text-[var(--text-muted)]"
          onMouseEnter={prefetchSpace}
          onFocus={prefetchSpace}
          onPointerDown={prefetchSpace}
          onClick={handleNavClick}
        >
          {subtitle ?? spaceKindLabel(space.kind)}
        </Link>
      ) : null}
      {menu}
    </div>
  );
}
