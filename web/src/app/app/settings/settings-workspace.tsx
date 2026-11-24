"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { SpaceNavItem } from "@/lib/todos";
import { ProfilePanel } from "./profile-panel";
import { AppearancePanel } from "./appearance-panel";
import { NotificationPanel } from "./notification-panel";
import { DataPanel } from "./data-panel";
import { SecurityPanel } from "./security-panel";
import { AboutPanel } from "./about-panel";
import { AdminResetPanel } from "@/app/admin/reset/admin-reset-panel";
import { AdminToolsPanel } from "@/app/admin/tools/admin-tools-panel";
import { AdminAccountsPanel } from "@/app/admin/admin-accounts-panel";
import { AdminErrorsPanel } from "@/app/admin/admin-errors-panel";
import { AdminAuditPanel } from "@/app/admin/admin-audit-panel";

type TabId =
  | "profile"
  | "appearance"
  | "notifications"
  | "data"
  | "security"
  | "about"
  | "admin-accounts"
  | "admin-errors"
  | "admin-audit"
  | "admin-reset"
  | "admin-ban"
  | "admin-signout"
  | "admin-delete"
  | "admin-recovery";

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

// 管理后台看板分组：账户管理 / 错误日志 / 操作记录（仅管理员可见，直接内嵌在设置页）
const ADMIN_DASHBOARD_GROUP: (typeof GROUPS)[number] = {
  title: "管理后台",
  items: [
    {
      id: "admin-accounts",
      label: "账户管理",
      desc: "启用/禁用、升级/降级、查看每个账号的空间个数",
    },
    {
      id: "admin-errors",
      label: "错误日志",
      desc: "报错信息、报错操作与时间",
    },
    {
      id: "admin-audit",
      label: "操作记录",
      desc: "管理员关键写操作的审计日志",
    },
  ],
};

// 管理员工具分组：仅管理员可见（由 isAdmin 控制是否拼进导航）
const ADMIN_GROUP: (typeof GROUPS)[number] = {
  title: "管理员工具",
  items: [
    {
      id: "admin-reset",
      label: "协助重置密码",
      desc: "凭邮箱为用户重置密码并生成新恢复码",
    },
    {
      id: "admin-ban",
      label: "封禁 / 解封",
      desc: "封禁用户并强制其所有设备下线，或解除封禁",
    },
    {
      id: "admin-signout",
      label: "强制下线",
      desc: "吊销某用户所有设备的会话",
    },
    {
      id: "admin-delete",
      label: "删除账号",
      desc: "删除用户及其数据（含空间转让/清理）",
    },
    {
      id: "admin-recovery",
      label: "恢复码管理",
      desc: "重生成或吊销用户的一次性恢复码",
    },
  ],
};

function isTabId(v: string | null): v is TabId {
  return (
    TABS.some((t) => t.id === v) ||
    v === "admin-accounts" ||
    v === "admin-errors" ||
    v === "admin-audit" ||
    v === "admin-reset" ||
    v === "admin-ban" ||
    v === "admin-signout" ||
    v === "admin-delete" ||
    v === "admin-recovery"
  );
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
  isAdmin?: boolean;
};

export function SettingsWorkspace(props: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("tab");
  const active: TabId = isTabId(raw) ? raw : "profile";
  const groups = props.isAdmin
    ? [...GROUPS, ADMIN_DASHBOARD_GROUP, ADMIN_GROUP]
    : GROUPS;
  const meta = [
    ...TABS,
    ...ADMIN_DASHBOARD_GROUP.items,
    ...ADMIN_GROUP.items,
  ].find((t) => t.id === active)!;

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
