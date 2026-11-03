"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { emitNotificationsChanged } from "@/lib/notify-events";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_TYPE_META,
  invalidateNotificationPrefsCache,
  parseNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notification-prefs";
import {
  SettingsFooter,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "./settings-ui";

const PREF_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS) as Array<
  keyof NotificationPrefs
>;

export function NotificationPanel({
  initialPrefs,
}: {
  initialPrefs?: unknown;
}) {
  const router = useRouter();
  const supabase = createClient();
  const initial = parseNotificationPrefs(initialPrefs);
  const [prefs, setPrefs] = useState<NotificationPrefs>(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const dirty = PREF_KEYS.some((k) => prefs[k] !== initial[k]);

  function set(key: keyof NotificationPrefs, value: boolean) {
    setPrefs((prev) => ({ ...prev, [key]: value }));
    setMsg("");
  }

  function reset() {
    setPrefs(initial);
    setMsg("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      setMsg("请先登录");
      return;
    }
    const { error } = await supabase
      .from("profiles")
      .update({ notification_prefs: prefs })
      .eq("id", user.id);
    setSaving(false);
    if (error) {
      setMsg(
        /notification_prefs/.test(error.message)
          ? "数据库还没有 notification_prefs 字段，请先执行迁移 20261102040000_notification_prefs.sql"
          : error.message,
      );
      return;
    }
    // 角标、消息中心、弹窗都按新偏好重算
    invalidateNotificationPrefsCache();
    emitNotificationsChanged();
    setMsg("已保存");
    router.refresh();
  }

  const closedCount = NOTIFICATION_TYPE_META.filter(
    (m) => prefs[m.key] === false,
  ).length;

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <SettingsSection
        title="通知类型"
        desc="关闭后，该类型的消息不再出现在消息中心、铃铛角标和右下角弹窗中"
      >
        {NOTIFICATION_TYPE_META.map((meta) => (
          <SettingsRow key={meta.key} label={meta.label} hint={meta.desc}>
            <SettingsToggle
              label={meta.label}
              checked={prefs[meta.key]}
              onChange={(v) => set(meta.key, v)}
              disabled={saving}
            />
          </SettingsRow>
        ))}
      </SettingsSection>

      <SettingsSection title="提醒方式" desc="控制消息怎么打扰你">
        <SettingsRow
          label="右下角弹窗"
          hint="关闭后新消息只体现在铃铛角标，不会打断当前操作"
        >
          <SettingsToggle
            label="右下角弹窗"
            checked={prefs.toast}
            onChange={(v) => set("toast", v)}
            disabled={saving}
          />
        </SettingsRow>

        <SettingsRow
          label="消息中心"
          hint={
            closedCount > 0
              ? `当前已关闭 ${closedCount} 类通知`
              : "当前接收全部类型的通知"
          }
        >
          <Link
            href="/app/notifications"
            prefetch
            className="text-xs font-medium text-[#2f5f8f] underline"
          >
            查看与管理已有通知
          </Link>
        </SettingsRow>
      </SettingsSection>

      <SettingsFooter
        dirty={dirty}
        saving={saving}
        msg={msg}
        onReset={reset}
        saveText="保存通知设置"
      />
    </form>
  );
}
