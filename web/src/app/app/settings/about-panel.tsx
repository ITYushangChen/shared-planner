"use client";

import { useEffect, useState } from "react";
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
  const [host, setHost] = useState("");

  // host 只能客户端取，避免 SSR 水合不一致
  useEffect(() => {
    setHost(window.location.host);
  }, []);

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
        <SettingsSection title="运行环境" desc="数据存放在你自建的服务器与数据库中">
          <SettingsRow label="站点地址">
            <p className="break-all text-sm text-[var(--brand-ink)]">
              {host || "—"}
            </p>
          </SettingsRow>
          <SettingsRow label="技术栈">
            <p className="text-sm text-[var(--brand-ink)]">
              Next.js · Supabase（自托管）· PostgreSQL
            </p>
          </SettingsRow>
        </SettingsSection>
      </div>

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
