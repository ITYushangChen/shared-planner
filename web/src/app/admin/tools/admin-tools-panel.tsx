"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useAdminGuard } from "@/lib/use-admin-guard";

type Mode = "ban" | "signout" | "delete" | "recovery";

const COPY: Record<Mode, { title: string; desc: string }> = {
  ban: {
    title: "封禁 / 解封账号",
    desc: "凭邮箱封禁用户：其所有设备会话会被强制登出，且再次登录将被拒绝（直到解封）。解封后恢复正常。不能封禁自己或其他管理员。",
  },
  signout: {
    title: "强制下线",
    desc: "吊销该用户所有设备的会话（刷新令牌），下次需重新登录。不会改动其密码。",
  },
  delete: {
    title: "删除账号",
    desc: "删除用户及其全部数据。其拥有的、仍有其他成员的空间会先转让给最早加入的成员；仅其一人拥有的空间将被一并删除。危险且不可恢复。",
  },
  recovery: {
    title: "恢复码管理",
    desc: "重生成一次性恢复码（明文仅展示这一次，用户凭它在「找回密码」页自助重设）；或吊销现有恢复码（之后用户只能找管理员重置）。",
  },
};

type ApiResult = {
  ok?: boolean;
  recoveryCode?: string;
  transferSpaces?: number;
  deleteSpaces?: number;
  error?: string;
};

/**
 * 账号管控面板，被设置页「管理员工具」下的 4 个 tab 复用（showTitle=false 由设置页标题区提供）。
 * 四种模式共用同一套「邮箱 → 调用路由 → 展示结果」逻辑，差异仅在按钮与额外输入。
 */
export function AdminToolsPanel({
  mode,
  showTitle = true,
}: {
  mode: Mode;
  showTitle?: boolean;
}) {
  const { guard } = useAdminGuard();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<ApiResult | null>(null);

  function endpointFor(m: Mode): string {
    switch (m) {
      case "ban":
        return "/auth/admin-ban";
      case "signout":
        return "/auth/admin-signout";
      case "delete":
        return "/auth/admin-delete";
      case "recovery":
        return "/auth/admin-recovery";
    }
  }

  async function call(payload: Record<string, unknown>) {
    setErr("");
    setMsg("");
    setLoading(true);
    setDone(null);
    try {
      const res = await fetch(endpointFor(mode), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      let data: ApiResult = {};
      try {
        data = (await res.json()) as ApiResult;
      } catch {
        data = {};
      }
      if (!res.ok) {
        setLoading(false);
        setErr(data.error || `请求失败（${res.status}）`);
        return;
      }
      setDone(data);
      if (mode === "delete") {
        setMsg(
          `已删除。${data.transferSpaces ?? 0} 个协作空间已转让给其他成员，${data.deleteSpaces ?? 0} 个无主空间已清理。`,
        );
      } else if (mode === "ban") {
        setMsg("操作成功。");
      } else if (mode === "signout") {
        setMsg("已吊销该用户所有设备的会话。");
      } else if (mode === "recovery") {
        setMsg("操作成功。");
      }
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
        <p className="text-sm text-zinc-500">请先以管理员账号登录后再使用此工具。</p>
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
          无权限：仅应用管理员可使用账号管控工具。
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

  const meta = COPY[mode];

  return (
    <div>
      {showTitle ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{meta.title}</h1>
          <p className="mt-2 text-sm text-zinc-500">{meta.desc}</p>
        </>
      ) : (
        <p className="text-sm text-zinc-500">{meta.desc}</p>
      )}

      <form
        onSubmit={(e: FormEvent) => e.preventDefault()}
        className="mt-8 flex max-w-md flex-col gap-3"
      >
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

        {mode === "ban" ? (
          <label className="text-sm text-zinc-700">
            封禁原因（可选）
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-400"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="如：违反使用规范"
            />
          </label>
        ) : null}

        {mode === "delete" ? (
          <label className="text-sm text-zinc-700">
            确认邮箱（再输入一次以确认）
            <input
              type="email"
              required
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-400"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder="再次输入目标邮箱"
              autoComplete="email"
            />
          </label>
        ) : null}

        {err ? (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</div>
        ) : null}
        {msg ? (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</div>
        ) : null}

        {/* 操作按钮区 */}
        <div className="mt-1 flex flex-col gap-2">
          {mode === "ban" ? (
            <>
              <button
                type="button"
                disabled={loading}
                onClick={() => call({ email: email.trim(), action: "ban", reason })}
                className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-red-700 disabled:opacity-50"
              >
                {loading ? "处理中…" : "封禁该用户"}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => call({ email: email.trim(), action: "unban" })}
                className="rounded-xl border border-[#2f5f8f]/55 px-4 py-2 text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7] disabled:opacity-50"
              >
                解封该用户
              </button>
            </>
          ) : mode === "recovery" ? (
            <>
              <button
                type="button"
                disabled={loading}
                onClick={() => call({ email: email.trim(), action: "regen" })}
                className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                {loading ? "处理中…" : "重生成恢复码"}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => call({ email: email.trim(), action: "revoke" })}
                className="rounded-xl border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition-colors duration-200 hover:bg-red-50 disabled:opacity-50"
              >
                吊销现有恢复码
              </button>
            </>
          ) : mode === "delete" ? (
            <button
              type="button"
              disabled={loading || confirmEmail.trim().toLowerCase() !== email.trim().toLowerCase()}
              onClick={() => call({ email: email.trim(), confirmEmail: confirmEmail.trim() })}
              className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? "处理中…" : "删除该账号"}
            </button>
          ) : (
            <button
              type="button"
              disabled={loading}
              onClick={() => call({ email: email.trim() })}
              className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? "处理中…" : "强制下线"}
            </button>
          )}
        </div>
      </form>

      {/* 恢复码：重生成后只展示这一次 */}
      {mode === "recovery" && done?.recoveryCode ? (
        <div className="mt-4">
          <p className="text-xs font-medium text-zinc-500">新恢复码（旧码已失效，请尽快转交）</p>
          <p className="mt-1 select-all break-all rounded-lg border border-[#2f5f8f]/40 bg-[#e8f0f7] px-3 py-2 font-mono text-sm text-zinc-900">
            {done.recoveryCode}
          </p>
        </div>
      ) : null}

      <p className="mt-8 text-xs leading-relaxed text-zinc-400">
        此操作会被记录并限流。管理员账号由运维手动授权。
      </p>
    </div>
  );
}
