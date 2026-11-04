"use client";

import { startTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * 内容区视图切换条。
 *
 * 原来这两组控制塞在最左图标栏里（日/周/月 + 象/历/待），
 * 单字缩写需要记忆，且和「去哪」的导航混在一起。
 * 现在按日历类软件的通行做法：时间粒度用分段控件、视图类型用文字按钮，
 * 统一放在内容区顶部，导航栏只负责页面跳转。
 */

const RANGES = [
  ["day", "日", "日视图"],
  ["week", "周", "周视图"],
  ["month", "月", "月视图"],
  ["all", "全部", "全部任务（不限时间）"],
] as const;

const VIEWS = [
  ["boards", "看板"],
  ["calendar", "日历"],
  ["list", "待办"],
] as const;

type RangeKey = (typeof RANGES)[number][0];
type ViewKey = (typeof VIEWS)[number][0];

export function ViewSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const rawRange = searchParams.get("range");
  const range: RangeKey =
    rawRange === "day" || rawRange === "month" || rawRange === "all"
      ? rawRange
      : "week";
  const rawView = searchParams.get("view");
  const view: ViewKey =
    rawView === "boards" || rawView === "list" ? rawView : "calendar";

  function patch(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) params.set(k, v);
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <div className="hidden items-center gap-2 md:flex">
      <div
        className="inline-flex overflow-hidden rounded-lg border border-[var(--border-muted)] bg-white"
        role="group"
        aria-label="时间范围"
      >
        {RANGES.map(([key, label, title]) => {
          const active = range === key;
          return (
            <button
              key={key}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={active}
              onClick={() => patch({ range: key })}
              className={[
                "px-2.5 py-1.5 text-xs transition-colors duration-200",
                active
                  ? "bg-[var(--brand)] font-medium text-white"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="inline-flex items-center gap-1" role="group" aria-label="视图类型">
        {VIEWS.map(([key, label]) => {
          const active = view === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => patch({ view: key })}
              className={[
                "rounded-lg border px-2.5 py-1.5 text-xs transition-colors duration-200",
                active
                  ? "border-[var(--brand)] bg-[var(--brand-soft)] font-medium text-[var(--brand)]"
                  : "border-[var(--border-muted)] bg-white text-[var(--text-secondary)] hover:border-[var(--brand)] hover:text-[var(--brand)]",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
