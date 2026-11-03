"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SettingsFooter, SettingsRow, SettingsSection, fieldClass } from "./settings-ui";
import { secondaryBtnClass } from "../ui-btn-class";

export function SecurityPanel({ email }: { email: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");

  function genRecoveryCode(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

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
    if (!current) {
      setErr("请输入当前密码");
      return;
    }
    if (next.length < 6) {
      setErr("新密码至少 6 位");
      return;
    }
    const types = [
      /\d/.test(next),
      /[a-zA-Z]/.test(next),
      /[^a-zA-Z0-9]/.test(next),
    ].filter(Boolean).length;
    if (types < 2) {
      setErr("新密码至少包含两种：数字、字母、特殊符号");
      return;
    }
    if (next !== confirmPwd) {
      setErr("两次输入的密码不一致");
      return;
    }
    setSaving(true);
    // 1) 先验证当前密码（re-auth），防止他人误改
    const { error: reErr } = await supabase.auth.signInWithPassword({
      email,
      password: current,
    });
    if (reErr) {
      setSaving(false);
      setErr("当前密码不正确，请重新输入");
      return;
    }
    // 2) 验证通过后再改密码
    const { error } = await supabase.auth.updateUser({ password: next });
    setSaving(false);
    if (error) {
      setErr(error.message);
      return;
    }
    // 改密成功后重新生成一次性找回码（旧的立即失效）
    try {
      const { data: me } = await supabase.auth.getUser();
      if (me.user) {
        const code = genRecoveryCode();
        await supabase.rpc("set_recovery_code", {
          p_user_id: me.user.id,
          p_code: code,
        });
        setRecoveryCode(code);
      }
    } catch {
      // 找回码生成失败不影响改密本身
    }
    setCurrent("");
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
          <SettingsSection title="修改密码" desc="为安全起见，需先验证当前密码">
            <SettingsRow label="当前密码" hint="用于验证是本人操作">
              <input
                type="password"
                className={fieldClass()}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="请输入当前密码"
                autoComplete="current-password"
              />
            </SettingsRow>
            <SettingsRow label="新密码" hint="至少 6 位，字母/数字/符号至少两种">
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
            {recoveryCode ? (
              <div className="rounded-lg border border-[#2f5f8f]/40 bg-[#e8f0f7] px-3 py-2 text-xs text-[#15487d]">
                <p className="font-medium">
                  新的密码找回码（请保存，下次忘记密码时在登录页「忘记密码」使用）：
                </p>
                <p className="mt-1 select-all break-all rounded bg-white px-2 py-1 font-mono text-sm text-zinc-900">
                  {recoveryCode}
                </p>
              </div>
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
