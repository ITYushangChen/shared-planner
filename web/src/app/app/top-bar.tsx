"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** 低频入口：报告 / 知识 / 资料 / 学习 */
const MENU_ITEMS = [
  { href: "/app/reports", label: "报告" },
  { href: "/app/knowledge", label: "知识" },
  { href: "/app/docs", label: "资料" },
  { href: "/app/study", label: "学习" },
] as const;

function titleFor(pathname: string, view: string | null): string {
  if (pathname === "/app") {
    if (view === "calendar") return "日历";
    if (view === "list") return "四象限待办";
    return "四象限";
  }
  if (pathname === "/app/spaces" || pathname.startsWith("/app/spaces/")) {
    return "空间";
  }
  if (pathname === "/app/settings" || pathname === "/app/profile") return "我的";
  if (pathname.startsWith("/app/notifications")) return "消息";
  if (pathname.startsWith("/app/reports")) return "报告";
  if (pathname.startsWith("/app/knowledge")) return "知识";
  if (pathname.startsWith("/app/docs")) return "资料";
  if (pathname.startsWith("/app/study")) return "学习";
  return "ShareTodo";
}

/** 顶栏：纯标题 + 右侧「···」低频入口 */
export function TopBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const title = titleFor(pathname, searchParams.get("view"));

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border-muted)] bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex h-12 w-full max-w-[1200px] items-center justify-between px-4 md:px-6">
      <p className="min-w-0 truncate text-[15px] font-semibold text-[var(--brand-ink)]">
        {title}
      </p>
      <div ref={menuRef} className="relative">
        <button
          type="button"
          aria-label="更多"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--brand-ink)]"
        >
          <MoreIcon />
        </button>
        {open ? (
          <div className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-xl border border-[var(--border-muted)] bg-white py-1 shadow-lg">
            {MENU_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                onClick={() => setOpen(false)}
                className="block px-4 py-2.5 text-sm font-medium text-[var(--brand-ink)] transition-colors hover:bg-[var(--surface-muted)]"
              >
                {item.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      </div>
    </header>
  );
}

function MoreIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="currentColor"
      aria-hidden
    >
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}
