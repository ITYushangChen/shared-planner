"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { SpaceNavItem } from "@/lib/todos";
import { ProfilePanel } from "./profile-panel";
import { AppearancePanel } from "./appearance-panel";
import { NotificationPanel } from "./notification-panel";
import { DataPanel } from "./data-panel";
import { SecurityPanel } from "./security-panel";
import { AboutPanel } from "./about-panel";
import { ProfileOverview } from "./profile-overview";
import {
  ADMIN_DASHBOARD_GROUP,
  ADMIN_GROUP,
  ALL_TABS,
  GROUPS,
  isTabId,
  type TabId,
} from "./settings-groups";
import { AdminResetPanel } from "@/app/admin/reset/admin-reset-panel";
import { AdminToolsPanel } from "@/app/admin/tools/admin-tools-panel";
import { AdminAccountsPanel } from "@/app/admin/admin-accounts-panel";
import { AdminErrorsPanel } from "@/app/admin/admin-errors-panel";
import { AdminAuditPanel } from "@/app/admin/admin-audit-panel";

type Props = {
  email: string;
  displayName: string;
  timezone: string;
  avatarUrl: string;
  spaceCount: number;
  globalPrefsRaw?: unknown;
  spacePrefsByIdRaw?: Record<string, unknown>;
  notificationPrefsRaw?: unknown;
  spaces: SpaceNavItem[];
  isAdmin?: boolean;
};

export function SettingsWorkspace(props: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("tab");
  const active: TabId | null = isTabId(raw) ? raw : null;

  const go = useCallback(
    (id: TabId) => {
      router.replace(`/app/settings?tab=${id}`, { scroll: false });
    },
    [router],
  );

  // 分组的收起/展开状态（默认全部收起，点击标题展开）
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set<string>(
        [...GROUPS, ADMIN_DASHBOARD_GROUP, ADMIN_GROUP].map((g) => g.title),
      ),
  );

  const toggleGroup = useCallback((title: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }, []);

  // 无 ?tab 参数 = 「我的页」总览（头像卡片 + 消息红点 + 设置分组）
  if (active === null) {
    return (
      <ProfileOverview
        email={props.email}
        displayName={props.displayName}
        avatarUrl={props.avatarUrl}
        isAdmin={props.isAdmin}
      />
    );
  }

  const groups = props.isAdmin
    ? [...GROUPS, ADMIN_DASHBOARD_GROUP, ADMIN_GROUP]
    : GROUPS;
  const meta = ALL_TABS.find((t) => t.id === active)!;

  return (
    <main className="flex flex-1 flex-col p-4 md:p-6">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border-muted)] bg-white shadow-sm">
        <header className="border-b border-[var(--border-muted)] px-5 py-4 md:px-8">
          <Link
            href="/app/settings"
            className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--brand)]"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
            </svg>
            返回我的
          </Link>
          <h1 className="text-xl font-semibold text-[var(--brand-ink)]">设置</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            管理你的账号、外观、通知与数据
          </p>
        </header>

        <div className="flex flex-1 flex-col md:flex-row">
          {/* 左侧分类导航（手机端横向滚动，桌面端常驻左栏） */}
          <nav
            aria-label="设置分类"
            className="flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--border-muted)] p-3 md:w-60 md:flex-col md:gap-1 md:border-b-0 md:border-r md:p-4"
          >
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.title);
              return (
                <div key={group.title} className="flex gap-2 md:flex-col md:gap-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.title)}
                    aria-expanded={!isCollapsed}
                    className="hidden items-center justify-between gap-1 px-2 pb-1 text-sm font-semibold uppercase tracking-wide text-[var(--brand-ink)] transition-colors duration-200 hover:text-[#185FA5] md:flex"
                  >
                    <span>{group.title}</span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden
                      className={`transition-transform duration-200 ${
                        isCollapsed ? "-rotate-90" : ""
                      }`}
                    >
                      <path
                        d="M6 9l6 6 6-6"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {!isCollapsed
                    ? group.items.map((item) => {
                        const on = item.id === active;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => go(item.id)}
                            aria-current={on ? "page" : undefined}
                            className={[
                              "shrink-0 rounded-lg px-3 py-2 text-left text-[13px] transition-colors duration-200",
                              on
                                ? "bg-[#E6F1FB] font-semibold text-[#185FA5]"
                                : "text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--brand-ink)]",
                            ].join(" ")}
                          >
                            {item.label}
                          </button>
                        );
                      })
                    : null}
                </div>
              );
            })}

          </nav>

          {/* 右侧内容区 */}
          <div className="min-w-0 flex-1 p-5 md:p-8">
            <header className="mb-5">
              <h2 className="text-base font-semibold text-[var(--brand-ink)]">
                {meta.label}
              </h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                {meta.desc}
              </p>
            </header>

            {active === "profile" ? (
              <ProfilePanel
                email={props.email}
                initialDisplayName={props.displayName}
                initialTimezone={props.timezone}
                initialAvatarUrl={props.avatarUrl}
              />
            ) : null}

            {active === "appearance" ? (
              <AppearancePanel
                spaces={props.spaces}
                initialGlobalPrefs={props.globalPrefsRaw}
                initialSpacePrefsById={props.spacePrefsByIdRaw}
              />
            ) : null}

            {active === "notifications" ? (
              <NotificationPanel initialPrefs={props.notificationPrefsRaw} />
            ) : null}

            {active === "data" ? <DataPanel spaces={props.spaces} /> : null}

            {active === "security" ? <SecurityPanel email={props.email} /> : null}

            {active === "about" ? (
              <AboutPanel
                email={props.email}
                timezone={props.timezone}
                spaceCount={props.spaceCount}
              />
            ) : null}

            {props.isAdmin && active === "admin-accounts" ? (
              <AdminAccountsPanel />
            ) : null}
            {props.isAdmin && active === "admin-errors" ? <AdminErrorsPanel /> : null}
            {props.isAdmin && active === "admin-audit" ? <AdminAuditPanel /> : null}

            {active === "admin-reset" ? <AdminResetPanel showTitle={false} /> : null}

            {active === "admin-ban" ? (
              <AdminToolsPanel mode="ban" showTitle={false} />
            ) : null}

            {active === "admin-signout" ? (
              <AdminToolsPanel mode="signout" showTitle={false} />
            ) : null}

            {active === "admin-delete" ? (
              <AdminToolsPanel mode="delete" showTitle={false} />
            ) : null}

            {active === "admin-recovery" ? (
              <AdminToolsPanel mode="recovery" showTitle={false} />
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
