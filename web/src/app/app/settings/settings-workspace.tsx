"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { SpaceNavItem } from "@/lib/todos";
import { ProfilePanel } from "./profile-panel";
import { AppearancePanel } from "./appearance-panel";
import { NotificationPanel } from "./notification-panel";
import { DataPanel } from "./data-panel";
import { SecurityPanel } from "./security-panel";
import { AboutPanel } from "./about-panel";

type TabId =
  | "profile"
  | "appearance"
  | "notifications"
  | "data"
  | "security"
  | "about";

const GROUPS: Array<{
  title: string;
  items: Array<{ id: TabId; label: string; desc: string }>;
}> = [
  {
    title: "账户",
    items: [
      { id: "profile", label: "个人资料", desc: "头像、昵称、时区和登录邮箱" },
      { id: "security", label: "安全与登录", desc: "修改密码、退出登录" },
    ],
  },
  {
    title: "应用",
    items: [
      { id: "appearance", label: "外观", desc: "背景、任务颜色与空间级覆盖" },
      {
        id: "notifications",
        label: "通知",
        desc: "按类型开关通知与右下角弹窗",
      },
    ],
  },
  {
    title: "其他",
    items: [
      { id: "data", label: "数据与集成", desc: "导出任务数据" },
      { id: "about", label: "关于", desc: "账户信息与快捷入口" },
    ],
  },
];

const TABS = GROUPS.flatMap((g) => g.items);

function isTabId(v: string | null): v is TabId {
  return TABS.some((t) => t.id === v);
}

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
};

export function SettingsWorkspace(props: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("tab");
  const active: TabId = isTabId(raw) ? raw : "profile";
  const meta = TABS.find((t) => t.id === active)!;

  const go = useCallback(
    (id: TabId) => {
      router.replace(`/app/settings?tab=${id}`, { scroll: false });
    },
    [router],
  );

  return (
    <main className="flex flex-1 flex-col p-4 md:p-6">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border-muted)] bg-white shadow-sm">
        <header className="border-b border-[var(--border-muted)] px-5 py-4 md:px-8">
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
            {GROUPS.map((group) => (
              <div key={group.title} className="flex gap-2 md:flex-col md:gap-1">
                <p className="hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:block">
                  {group.title}
                </p>
                {group.items.map((item) => {
                  const on = item.id === active;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => go(item.id)}
                      aria-current={on ? "page" : undefined}
                      className={[
                        "shrink-0 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-200",
                        on
                          ? "bg-[#E6F1FB] font-semibold text-[#185FA5]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--brand-ink)]",
                      ].join(" ")}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
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
          </div>
        </div>
      </div>
    </main>
  );
}
