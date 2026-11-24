"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAdminGuard } from "@/lib/use-admin-guard";

/**
 * 管理员协助重置密码面板。
 * 同时被两处使用：
 *   1) /admin/reset 独立页（showTitle=true，含页面级标题）；
 *   2) /app/settings 设置页「管理员工具 → 协助重置密码」tab（showTitle=false，
 *      由设置页的 tab 头部提供标题与说明）。
 */
export function AdminResetPanel({ showTitle = true }: { showTitle?: boolean }) {
  const { guard } = useAdminGuard();
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/auth/admin-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: email.trim() }),
      });
      let data: {
        error?: string;
        ok?: boolean;
        recoveryCode?: string;
      } = {};
      try {
        data = (await res.json()) as typeof data;
      } catch {
        data = {};
      }
      if (!res.ok) {
        setLoading(false);
        setErr(data.error || `请求失败（${res.status}）`);
        return;
      }
      setRecoveryCode(data.recoveryCode ?? "");
      setDone(true);
    } catch {
      setLoading(false);
      setErr("网络错误，请重试");
      return;
    }
    setLoading(false);
  }

  if (guard === "loading") {
    return <p className="text-sm text-zinc-500">加载中…</p>;
  }

  if (guard === "logged-out") {
    return (
      <div>
        <p className="text-sm text-zinc-500">
          请先以管理员账号登录后再使用此工具。
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800"
        >
          去登录
        </Link>
      </div>
    );
  }

  if (guard === "forbidden") {
    return (
      <div>
        <p className="rounded-lg bg-red-50 px-3 py-3 text-sm text-red-600">
          无权限：仅应用管理员可协助重置他人密码。
        </p>
        <Link
          href="/app"
          className="mt-6 inline-block rounded-xl border border-[#2f5f8f]/55 px-4 py-2 text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7]"
        >
          返回应用
        </Link>
      </div>
    );
  }

  return (
    <div>
      {showTitle ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            密码重置（管理员工具）
          </h1>
          <p className="mt-2 text-sm text-zinc-500">
            凭目标用户邮箱重置其密码：系统会重生成一次性恢复码，转交用户后由其自行在「找回密码」页重设密码（你无需也不接触任何明文密码）。
          </p>
        </>
      ) : (
        <p className="text-sm text-zinc-500">
          凭目标用户邮箱重置其密码：系统会重生成一次性恢复码，转交用户后由其自行在「找回密码」页重设密码（你无需也不接触任何明文密码）。
        </p>
      )}

      {done ? (
        <div className="mt-8 space-y-4">
          <p className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-700">
            密码已重置，该用户所有设备的旧会话已失效。请通过安全渠道把下方恢复码告知该用户，并提醒其前往「找回密码」页用此码重设自己的密码。
          </p>
          <div>
            <p className="text-xs font-medium text-zinc-500">新恢复码（旧码已失效）</p>
            <p className="mt-1 select-all break-all rounded-lg border border-[#2f5f8f]/40 bg-[#e8f0f7] px-3 py-2 font-mono text-sm text-zinc-900">
              {recoveryCode || "（写入失败，请重试重置）"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDone(false);
              setEmail("");
              setRecoveryCode("");
            }}
            className="block w-full rounded-xl border border-[#2f5f8f]/55 px-4 py-2 text-center text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7]"
          >
            再重置一个
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-8 flex max-w-md flex-col gap-3">
          <label className="text-sm text-zinc-700">
            目标用户邮箱
            <input
              type="email"
              required
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-400"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              autoComplete="email"
            />
          </label>

          {err ? (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {err}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "处理中…" : "重置并生成恢复码"}
          </button>
        </form>
      )}

      <p className="mt-8 text-xs leading-relaxed text-zinc-400">
        此操作会被记录并限流（每 IP 每小时 10 次）。管理员账号由运维手动授权。
      </p>
    </div>
  );
}
