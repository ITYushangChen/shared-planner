"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SettingsFooter, SettingsRow, SettingsSection, fieldClass } from "./settings-ui";

const TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
];

type Props = {
  email: string;
  initialDisplayName: string;
  initialTimezone: string;
  initialAvatarUrl: string;
};

export function ProfilePanel({
  email,
  initialDisplayName,
  initialTimezone,
  initialAvatarUrl = "",
}: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");

  const dirty =
    displayName !== initialDisplayName ||
    timezone !== initialTimezone ||
    avatarUrl !== initialAvatarUrl;

  function reset() {
    setDisplayName(initialDisplayName);
    setTimezone(initialTimezone);
    setAvatarUrl(initialAvatarUrl);
    setMsg("");
  }

  async function onPickFile(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMsg("请选择图片文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMsg("图片需小于 5MB");
      return;
    }
    setUploading(true);
    setMsg("上传中…");
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setUploading(false);
      setMsg("请先登录");
      return;
    }
    const ext =
      file.type === "image/png"
        ? "png"
        : file.type === "image/webp"
          ? "webp"
          : file.type === "image/gif"
            ? "gif"
            : "jpg";
    const path = `${user.id}/avatar/${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("backgrounds")
      .upload(path, file, { upsert: true, contentType: file.type });
    setUploading(false);
    if (error) {
      setMsg(
        error.message.includes("Bucket not found")
          ? "未找到 backgrounds 存储桶，请先执行 storage 迁移 SQL"
          : error.message,
      );
      return;
    }
    const { data } = supabase.storage.from("backgrounds").getPublicUrl(path);
    setAvatarUrl(data.publicUrl);
    setMsg("图片已上传，记得保存");
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
      .update({
        display_name: displayName.trim() || email.split("@")[0] || "User",
        email: email || user.email,
        timezone,
        avatar_url: avatarUrl.trim() || null,
      })
      .eq("id", user.id);
    setSaving(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setMsg("已保存");
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <SettingsSection
        title="基本信息"
        desc="这些信息会展示给同一空间内的其他成员"
      >
        <SettingsRow label="头像" hint="JPG / PNG / WebP / GIF，≤ 5MB">
          <div className="flex flex-wrap items-center gap-3">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt="头像预览"
                className="h-14 w-14 rounded-full border border-[var(--border-muted)] object-cover"
              />
            ) : (
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--surface-muted)] text-sm text-[var(--text-muted)]">
                未设置
              </span>
            )}
            <div className="flex flex-1 flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <label className="inline-flex cursor-pointer items-center rounded-lg border border-[#2f5f8f]/40 bg-[#e8f0f7] px-3 py-1.5 text-xs font-medium text-[#2f5f8f] transition-colors hover:bg-[#2f5f8f] hover:text-white">
                  {uploading ? "上传中…" : "上传图片"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    disabled={uploading || saving}
                    onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                {avatarUrl ? (
                  <button
                    type="button"
                    className="rounded-lg border border-[var(--border-muted)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
                    onClick={() => setAvatarUrl("")}
                    disabled={uploading || saving}
                  >
                    移除
                  </button>
                ) : null}
              </div>
              <input
                className={fieldClass()}
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="或粘贴图片 URL"
              />
            </div>
          </div>
        </SettingsRow>

        <SettingsRow label="昵称" hint="留空则使用邮箱前缀">
          <input
            className={fieldClass()}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={email.split("@")[0] || "昵称"}
          />
        </SettingsRow>

        <SettingsRow label="登录邮箱" hint="邮箱即登录账号，暂不支持在此修改">
          <input className={fieldClass(true)} value={email} readOnly disabled />
        </SettingsRow>

        <SettingsRow label="时区" hint="影响日历、日报与提醒的时间基准">
          <select
            className={fieldClass()}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsSection>

      <SettingsFooter
        dirty={dirty}
        saving={saving || uploading}
        msg={msg}
        onReset={reset}
      />
    </form>
  );
}
