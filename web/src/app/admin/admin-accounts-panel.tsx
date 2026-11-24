"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Account = {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  is_admin: boolean;
  banned: boolean;
  banned_at: string | null;
  created_at: string;
  space_count: number;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const roleBadge = (isAdmin: boolean) =>
  isAdmin
    ? "bg-[#185FA5] text-white"
    : "bg-zinc-100 text-zinc-600";

const statusBadge = (banned: boolean) =>
  banned
    ? "bg-red-50 text-red-600"
    : "bg-emerald-50 text-emerald-700";

/**
 * 管理后台「账户管理」面板：列出所有账号（含空间个数，不含空间名称/任务），
 * 支持启用/禁用（封禁）、升级/降级（管理员标志）。
 */
export function AdminAccountsPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [me, setMe] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/auth/admin-accounts", { credentials: "same-origin" });
      const data = (await res.json()) as { accounts?: Account[]; error?: string };
      if (!res.ok) {
        setErr(data.error || `请求失败（${res.status}）`);
        return;
      }
      setAccounts(data.accounts ?? []);
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    createClient()
      .auth.getUser()
      .then(({ data }: { data: { user: { email?: string } | null } }) => {
        if (data.user?.email) setMe(data.user.email.toLowerCase());
      })
      .catch(() => {});
  }, [load]);

  async function act(account: Account, action: "promote" | "demote" | "ban" | "unban") {
    setBusyId(account.id);
    setErr("");
    setMsg("");
    try {
      const isRole = action === "promote" || action === "demote";
      const url = isRole ? "/auth/admin-accounts" : "/auth/admin-ban";
      const body = isRole
        ? { email: account.email, action }
        : { email: account.email, action };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string; ok?: boolean };
      if (!res.ok) {
        setErr(data.error || `请求失败（${res.status}）`);
        return;
      }
      const label: Record<typeof action, string> = {
        promote: "已升级为管理员",
        demote: "已降级为成员",
        ban: "已封禁",
        unban: "已解封",
      };
      setMsg(`${account.email ?? account.display_name} ${label[action]}`);
      await load();
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p className="text-sm text-zinc-500">加载中…</p>;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-zinc-500">共 {accounts.length} 个账号；空间个数 = 拥有或加入的空间去重数。</p>
        <button
          type="button"
          onClick={load}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-50"
        >
          刷新
        </button>
      </div>

      {err ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</div> : null}
      {msg ? <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</div> : null}

      <div className="overflow-x-auto rounded-xl border border-zinc-200">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
              <th className="px-4 py-2.5 font-medium">账号</th>
              <th className="px-4 py-2.5 font-medium">角色</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 text-right font-medium">空间个数</th>
              <th className="px-4 py-2.5 font-medium">注册时间</th>
              <th className="px-4 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const self = me !== "" && a.email?.toLowerCase() === me;
              const busy = busyId === a.id;
              return (
                <tr key={a.id} className="border-b border-zinc-100 last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-zinc-800">{a.display_name}</div>
                    <div className="text-xs text-zinc-400">{a.email ?? "（无邮箱）"}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${roleBadge(a.is_admin)}`}>
                      {a.is_admin ? "管理员" : "成员"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(a.banned)}`}>
                      {a.banned ? "已封禁" : "正常"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-700">{a.space_count}</td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">{fmtDate(a.created_at)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {a.is_admin ? (
                        <button
                          type="button"
                          disabled={busy || self}
                          onClick={() => act(a, "demote")}
                          className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                          title={self ? "不能降级自己" : "降级为普通成员"}
                        >
                          降级
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act(a, "promote")}
                          className="rounded-md border border-[#185FA5]/40 px-2 py-1 text-xs text-[#185FA5] transition-colors hover:bg-[#E6F1FB] disabled:opacity-40"
                        >
                          升级
                        </button>
                      )}

                      {a.banned ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act(a, "unban")}
                          className="rounded-md border border-emerald-300 px-2 py-1 text-xs text-emerald-600 transition-colors hover:bg-emerald-50 disabled:opacity-40"
                        >
                          启用
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || a.is_admin}
                          onClick={() => act(a, "ban")}
                          className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                          title={a.is_admin ? "不能封禁管理员" : "封禁该账号"}
                        >
                          禁用
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
