"use client";

import Link from "next/link";
import { SettingsRow, SettingsSection } from "./settings-ui";

export function AboutPanel({
  email,
  timezone,
  spaceCount,
}: {
  email: string;
  timezone: string;
  spaceCount: number;
}) {
  return (
    <>
      <SettingsSection title="账户" desc="当前登录账号的基本信息">
        <SettingsRow label="账号">
          <p className="text-sm text-[var(--brand-ink)]">{email || "—"}</p>
        </SettingsRow>
        <SettingsRow label="时区">
          <p className="text-sm text-[var(--brand-ink)]">{timezone || "—"}</p>
        </SettingsRow>
        <SettingsRow label="已加入空间">
          <p className="text-sm text-[var(--brand-ink)]">{spaceCount} 个</p>
        </SettingsRow>
      </SettingsSection>

      <div className="mt-5">
        <SettingsSection title="快捷入口">
          <SettingsRow label="总览" hint="日历 / 看板 / 列表">
            <Link
              href="/app?view=calendar&range=week"
              className="text-sm font-medium text-[#2f5f8f] underline"
            >
              打开总览
            </Link>
          </SettingsRow>
          <SettingsRow label="消息中心" hint="系统通知与日报">
            <Link
              href="/app/notifications"
              className="text-sm font-medium text-[#2f5f8f] underline"
            >
              打开消息中心
            </Link>
          </SettingsRow>
          <SettingsRow label="报告中心" hint="日报 / 周报 / 月报">
            <Link href="/app/reports" className="text-sm font-medium text-[#2f5f8f] underline">
              打开报告中心
            </Link>
          </SettingsRow>
        </SettingsSection>
      </div>
    </>
  );
}
