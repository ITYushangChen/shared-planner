"use client";

import { FormEvent, Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { DEFAULT_APP_PATH, safeInternalPath } from "@/lib/safe-redirect";
import { mapAuthError } from "@/lib/error-map";

type MsgKind = "info" | "error" | "success";

/** 与 /auth/password 接口共用同一套映射，避免两处翻译不一致 */
function translateAuthError(message: string): string {
  return mapAuthError(message);
}

// 注册密码规则：≥6 位，且至少包含「数字 / 字母 / 特殊符号」中的两种组合
// 仅用于注册校验，登录不强制（避免老用户简单密码无法登录）
function passwordRule(pw: string): string | null {
  if (pw.length < 6) return "密码至少 6 位";
  const hasDigit = /\d/.test(pw);
  const hasLetter = /[a-zA-Z]/.test(pw);
  const hasSpecial = /[^a-zA-Z0-9]/.test(pw);
  const types = [hasDigit, hasLetter, hasSpecial].filter(Boolean).length;
  if (types < 2) return "密码至少包含两种：数字、字母、特殊符号";
  return null;
}

function msgClass(kind: MsgKind): string {
  if (kind === "error")
    return "rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600";
  if (kind === "success")
    return "rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700";
  return "rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-secondary)]";
}

function LoginForm() {
  const searchParams = useSearchParams();
  // ⚠️ 安全：next 来自 query，必须过站内白名单（挡 //evil.com 之类协议相对 URL）
  const next = safeInternalPath(searchParams.get("next"), DEFAULT_APP_PATH);
  const callbackError = searchParams.get("error");

  const envOk = useMemo(
    () =>
      Boolean(
        process.env.NEXT_PUBLIC_SUPABASE_URL &&
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      ),
    [],
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [msg, setMsg] = useState(
    callbackError ? "登录已过期，请重新登录" : "",
  );
  const [msgKind, setMsgKind] = useState<MsgKind>(
    callbackError ? "error" : "info",
  );
  const [recoveryCode, setRecoveryCode] = useState("");
  const [loading, setLoading] = useState(false);

  function setMessage(text: string, kind: MsgKind) {
    setMsg(text);
    setMsgKind(kind);
  }

  async function authPassword(mode: "signin" | "signup") {
    if (!envOk) {
      setMessage("服务未正确配置，请联系管理员", "error");
      return;
    }
    if (mode === "signup") {
      const err = passwordRule(password);
      if (err) {
        setMessage(err, "error");
        return;
      }
    }

    setLoading(true);
    setMessage(mode === "signup" ? "注册中…" : "登录中…", "info");

    try {
      const res = await fetch("/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          mode,
          email: email.trim(),
          password,
        }),
      });

      let data: { error?: string; ok?: boolean; recoveryCode?: string } = {};
      try {
        data = (await res.json()) as { error?: string; ok?: boolean };
      } catch {
        data = {};
      }

      if (!res.ok) {
        setLoading(false);
        setMessage(translateAuthError(data.error || ""), "error");
        return;
      }

      // 注册成功且返回了一次性恢复码：先展示，不自动跳转
      if (mode === "signup" && data.recoveryCode) {
        setRecoveryCode(data.recoveryCode);
        // 修复：此前不清空 msg，注册成功后下方仍残留「注册中…」
        setMsg("");
        setLoading(false);
        return;
      }

      setMessage("登录成功，正在进入…", "success");
      // 整页跳转，带上服务端刚写入的 Set-Cookie
      window.location.assign(next);
    } catch {
      setLoading(false);
      setMessage("网络错误，请检查网络后重试", "error");
    }
  }

  async function signIn(e?: FormEvent) {
    e?.preventDefault();
    await authPassword("signin");
  }

  async function signUp() {
    await authPassword("signup");
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        SharedPlanner
      </h1>
      <p className="mt-2 text-sm text-zinc-500">
        共享日程与待办协作 · 用邮箱登录或注册
      </p>

      {!envOk ? (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          服务未正确配置，请联系管理员。
        </p>
      ) : null}

      <form onSubmit={signIn} className="mt-8 flex flex-col gap-3">
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
          密码
          <span className="relative mt-1 block">
            <input
              type={showPassword ? "text" : "password"}
              required
              minLength={6}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 pr-16 text-zinc-900 outline-none focus:border-zinc-400"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-[#2f5f8f] hover:bg-[#e8f0f7]"
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
            >
              {showPassword ? "隐藏" : "显示"}
            </button>
          </span>
        </label>

        <div className="mt-2 flex gap-2">
          <button
            type="submit"
            disabled={loading || !envOk}
            className="flex-1 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "处理中…" : "登录"}
          </button>
          <button
            type="button"
            disabled={loading || !envOk}
            onClick={() => void signUp()}
            className="flex-1 rounded-xl border border-[#2f5f8f]/55 px-4 py-2 text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7] disabled:cursor-not-allowed disabled:opacity-50"
          >
            注册
          </button>
        </div>

        <p className="text-xs leading-relaxed text-zinc-400">
          注册时密码需至少 6 位，且包含数字、字母、特殊符号中的两种。
        </p>
      </form>

      <p className="mt-3 text-right">
        <Link
          href="/forgot-password"
          className="text-xs text-[#2f5f8f] transition-colors hover:underline"
        >
          忘记密码？
        </Link>
      </p>

      {recoveryCode ? (
        <div className="mt-4 rounded-lg border border-[#2f5f8f]/40 bg-[#e8f0f7] px-4 py-3">
          <p className="text-sm font-medium text-[#15487d]">
            注册成功 · 请保存你的密码找回码
          </p>
          <p className="mt-1 text-xs text-[#2f5f8f]">
            忘记密码时，可在「忘记密码」页凭此码直接重置（仅显示这一次）：
          </p>
          <p className="mt-2 select-all break-all rounded bg-white px-3 py-2 font-mono text-base text-zinc-900">
            {recoveryCode}
          </p>
          <button
            type="button"
            onClick={() => {
              setRecoveryCode("");
              window.location.assign(next);
            }}
            className="mt-3 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800"
          >
            进入应用
          </button>
        </div>
      ) : null}

      <div aria-live="polite" role="status">
        {msg ? <p className={`mt-4 whitespace-pre-wrap ${msgClass(msgKind)}`}>{msg}</p> : null}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-md px-6 py-16 text-sm text-zinc-500">
          加载登录页…
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
