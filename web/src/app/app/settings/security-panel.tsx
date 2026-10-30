"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SettingsFooter, SettingsRow, SettingsSection, fieldClass } from "./settings-ui";
import { secondaryBtnClass } from "../ui-btn-class";

export function SecurityPanel({ email }: { email: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [next, setNext] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const dirty = next.length > 0 || confirmPwd.length > 0;

  function reset() {
    setNext("");
    setConfirmPwd("");
    setMsg("");
    setErr("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    if (next.length < 6) {
      setErr("密码至少 6 位");
      return;
    }
    if (next !== confirmPwd) {
      setErr("两次输入的密码不一致");
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: next });
    setSaving(false);
    if (error) {
      setErr(error.message);
      return;
    }
    setNext("");
    setConfirmPwd("");
    setMsg("密码已更新，下次登录请使用新密码");
  }

  async function signOutAll() {
    if (!confirm("在所有设备上退出登录？")) return;
    await supabase.auth.signOut({ scope: "global" });
    router.push("/login");
    router.refresh();
  }

  async function signOutHere() {
    if (!confirm("退出当前账号？")) return;
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      <form onSubmit={(e) => void onSubmit(e)}>
        <SettingsSection title="登录方式" desc="本应用使用邮箱 + 密码登录">
          <SettingsRow label="登录邮箱" hint="邮箱即账号，暂不支持在此修改">
            <input className={fieldClass(true)} value={email} readOnly disabled />
          </SettingsRow>
        </SettingsSection>

        <div className="mt-5">
          <SettingsSection title="修改密码" desc="修改后立即生效，当前设备保持登录">
            <SettingsRow label="新密码" hint="至少 6 位">
              <input
                type="password"
                className={fieldClass()}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="输入新密码"
                autoComplete="new-password"
              />
            </SettingsRow>
            <SettingsRow label="确认新密码">
              <input
                type="password"
                className={fieldClass()}
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                placeholder="再输入一次"
                autoComplete="new-password"
              />
            </SettingsRow>
            {err ? (
              <div className="py-3 text-xs text-red-600">{err}</div>
            ) : null}
            {!err && msg ? (
              <div className="py-3 text-xs text-emerald-700">{msg}</div>
            ) : null}
          </SettingsSection>
        </div>

        <SettingsFooter
          dirty={dirty}
          saving={saving}
          msg={msg}
          onReset={reset}
          saveText="更新密码"
        />
      </form>

      <div className="mt-5">
        <SettingsSection title="退出登录" desc="退出后需要重新输入邮箱和密码" danger>
          <SettingsRow label="退出当前设备" hint="只影响这台浏览器">
            <button
              type="button"
              onClick={() => void signOutHere()}
              className={secondaryBtnClass()}
            >
              退出登录
            </button>
          </SettingsRow>
          <SettingsRow label="退出所有设备" hint="同时清除其他设备上的登录状态">
            <button
              type="button"
              onClick={() => void signOutAll()}
              className="rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
            >
              在所有设备退出
            </button>
          </SettingsRow>
        </SettingsSection>
      </div>
    </>
  );
}
