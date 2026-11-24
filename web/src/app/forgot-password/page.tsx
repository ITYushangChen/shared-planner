"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

function passwordTypes(pw: string): number {
  return [
    /\d/.test(pw),
    /[a-zA-Z]/.test(pw),
    /[^a-zA-Z0-9]/.test(pw),
  ].filter(Boolean).length;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    if (next.length < 6) {
      setErr("新密码至少 6 位");
      return;
    }
    if (passwordTypes(next) < 2) {
      setErr("新密码至少包含两种：数字、字母、特殊符号");
      return;
    }
    if (next !== confirmPwd) {
      setErr("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
          newPassword: next,
        }),
      });
      let data: { error?: string; ok?: boolean } = {};
      try {
        data = (await res.json()) as { error?: string; ok?: boolean };
      } catch {
        data = {};
      }
      if (!res.ok) {
        setLoading(false);
        setErr(data.error || `请求失败（${res.status}）`);
        return;
      }
      setDone(true);
    } catch {
      setLoading(false);
      setErr("网络错误，请重试");
      return;
    }
    setLoading(false);
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        找回密码
      </h1>
      <p className="mt-2 text-sm text-zinc-500">
        凭注册 / 改密时保存的「一次性恢复码」重置密码（无需邮件）
      </p>

      {done ? (
        <div className="mt-8 space-y-4">
          <p className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-700">
            密码已重置，请用新密码登录。
          </p>
          <Link
            href="/login"
            className="block rounded-xl bg-zinc-900 px-4 py-2 text-center text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800"
          >
            去登录
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3">
          <label className="text-sm text-zinc-700">
            邮箱
            <input
              type="email"
              required
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-400"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
          <label className="text-sm text-zinc-700">
            恢复码
            <input
              type="text"
              required
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 font-mono text-zinc-900 outline-none focus:border-zinc-400"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="注册/改密时保存的 16 位恢复码"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="text-sm text-zinc-700">
            新密码
            <input
              type="password"
              required
              minLength={6}
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-400"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="至少 6 位（字母/数字/符号，至少两种）"
              autoComplete="new-password"
            />
          </label>
          <label className="text-sm text-zinc-700">
            确认新密码
            <input
              type="password"
              required
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-400"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              placeholder="再输入一次"
              autoComplete="new-password"
            />
          </label>

          {err ? (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {err}
            </div>
          ) : null}
          {msg ? (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {msg}
            </div>
          ) : null}

          <div className="mt-2 flex gap-2">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              重置密码
            </button>
            <Link
              href="/login"
              className="flex-1 rounded-xl border border-[#2f5f8f]/55 px-4 py-2 text-center text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7]"
            >
              返回登录
            </Link>
          </div>
        </form>
      )}

      <p className="mt-8 text-xs leading-relaxed text-zinc-400">
        忘了恢复码？可让空间管理员前往「密码重置」工具（
        <Link href="/admin/reset" className="text-[#2f5f8f] hover:underline">
          /admin/reset
        </Link>
        ）凭你的邮箱协助重置。
      </p>
    </main>
  );
}
