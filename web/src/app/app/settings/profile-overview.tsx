"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { getAuthUser } from "@/lib/auth-user";
import {
  disabledNotificationTypes,
  loadNotificationPrefs,
} from "@/lib/notification-prefs";
import { SignOutButton } from "../sign-out-button";
import {
  ADMIN_DASHBOARD_GROUP,
  GROUPS,
  type SettingsGroup,
} from "./settings-groups";

type Props = {
  email: string;
  displayName: string;
  avatarUrl: string;
  isAdmin?: boolean;
};

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-1.5 pb-2 pt-4 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-muted)]">
      {children}
    </p>
  );
}

/** 设置项一行：左侧图标+名称，右侧说明 + 右箭头 */
function SettingRow({ id, label, desc }: { id: string; label: string; desc: string }) {
  return (
    <Link
      href={`/app/settings?tab=${id}`}
      prefetch
      className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--surface-muted)]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-[var(--brand-ink)]">
          {label}
        </span>
        <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
          {desc}
        </span>
      </span>
      <ChevronRightIcon />
    </Link>
  );
}

/** 分组卡片：标题 + 白色圆角卡片 + 行间细分割线 */
function GroupCard({ group }: { group: SettingsGroup }) {
  return (
    <section>
      <SectionLabel>{group.title}</SectionLabel>
      <div className="overflow-hidden rounded-2xl border border-[var(--border-muted)] bg-white shadow-sm">
        <div className="flex flex-col divide-y divide-[var(--border-muted)]">
          {group.items.map((item) => (
            <SettingRow key={item.id} id={item.id} label={item.label} desc={item.desc} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** 「消息」入口：带未读红点，红点=未读通知 + 待处理冲突 */
function MessageRow() {
  const supabase = createClient();
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    const user = await getAuthUser();
    if (!user) return;

    const prefs = await loadNotificationPrefs(supabase, user.id);
    const disabled = disabledNotificationTypes(prefs);

    let noteQuery = supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_read", false);
    if (disabled.length > 0) {
      noteQuery = noteQuery.not("type", "in", `(${disabled.join(",")})`);
    }

    const [notesRes, conflictsRes] = await Promise.all([
      noteQuery,
      supabase
        .from("conflict_resolutions")
        .select("id", { count: "exact", head: true })
        .or(`user_id.eq.${user.id},creator_id.eq.${user.id}`)
        .in("status", ["pending", "escalated"]),
    ]);

    setUnread((notesRes.count ?? 0) + (conflictsRes.count ?? 0));
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Link
      href="/app/notifications"
      prefetch
      className="flex items-center gap-3 rounded-2xl border border-[var(--border-muted)] bg-white px-4 py-4 shadow-sm transition-colors hover:bg-[var(--surface-muted)]"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--brand-soft)] text-[var(--brand)]">
        <BellIcon />
      </span>
      <span className="flex-1 text-sm font-medium text-[var(--brand-ink)]">
        消息
      </span>
      {unread > 0 ? (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
      <ChevronRightIcon />
    </Link>
  );
}

/** 「我的页」：头像卡片 + 消息红点 + 设置分组 + 退出登录（移动 App 式） */
export function ProfileOverview({ email, displayName, avatarUrl, isAdmin }: Props) {
  const name = displayName?.trim() || email.split("@")[0] || "用户";
  const initial = name.charAt(0).toUpperCase() || "我";
  const groups = isAdmin ? [...GROUPS, ADMIN_DASHBOARD_GROUP] : GROUPS;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-5 md:px-6">
      {/* 头部：头像 + 昵称 + 邮箱，点击进个人资料 */}
      <Link
        href="/app/settings?tab=profile"
        prefetch
        className="flex items-center gap-4 rounded-2xl border border-[var(--border-muted)] bg-white p-5 shadow-sm transition-colors hover:bg-[var(--surface-muted)]"
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt="头像"
            className="h-16 w-16 shrink-0 rounded-full border border-[var(--border-muted)] object-cover"
          />
        ) : (
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[var(--brand-soft)] text-2xl font-semibold text-[var(--brand)]">
            {initial}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lg font-semibold text-[var(--brand-ink)]">
            {name}
          </span>
          <span className="mt-0.5 block truncate text-sm text-[var(--text-muted)]">
            {email}
          </span>
        </span>
        <ChevronRightIcon />
      </Link>

      {/* 消息入口（未读红点） */}
      <div className="mt-3">
        <MessageRow />
      </div>

      {/* 设置分组 */}
      {groups.map((group) => (
        <GroupCard key={group.title} group={group} />
      ))}

      {/* 退出登录 */}
      <div className="mt-6">
        <SignOutButton />
      </div>
    </main>
  );
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 11-6 0m6 0H9"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0 text-[var(--text-muted)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  );
}
