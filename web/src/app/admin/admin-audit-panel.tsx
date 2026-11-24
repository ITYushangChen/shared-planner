"use client";

import { useCallback, useEffect, useState } from "react";

type AuditRow = {
  id: string;
  action: string;
  actor_email: string | null;
  target_type: string | null;
  target_email: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

const ACTION_LABELS: Record<string, string> = {
  admin_password_reset: "协助重置密码",
  admin_ban: "封禁账号",
  admin_unban: "解封账号",
  admin_force_signout: "强制下线",
  admin_delete_user: "删除账号",
  admin_recovery_regen: "重生成恢复码",
  admin_recovery_revoke: "吊销恢复码",
  admin_promote: "升级为管理员",
  admin_demote: "降级为成员",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 管理后台「操作记录」面板：展示管理员关键写操作的审计日志（谁、何时、对谁、做了什么）。
 */
export function AdminAuditPanel() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/auth/admin-audit", { credentials: "same-origin" });
      const data = (await res.json()) as { logs?: AuditRow[]; error?: string };
      if (!res.ok) {
        setErr(data.error || `请求失败（${res.status}）`);
        return;
      }
      setLogs(data.logs ?? []);
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="text-sm text-zinc-500">加载中…</p>;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-zinc-500">共 {logs.length} 条（按时间倒序，最多 100 条）。</p>
        <button
          type="button"
          onClick={load}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-50"
        >
          刷新
        </button>
      </div>

      {err ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</div> : null}

      {logs.length === 0 ? (
        <p className="rounded-lg bg-zinc-50 px-4 py-8 text-center text-sm text-zinc-400">
          暂无操作记录
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
          {logs.map((l) => {
            const extra = Object.keys(l.detail ?? {}).filter((k) => k !== "email");
            return (
              <li key={l.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="rounded-md bg-[#E6F1FB] px-2 py-0.5 text-[11px] font-medium text-[#185FA5]">
                    {ACTION_LABELS[l.action] ?? l.action}
                  </span>
                  <span className="ml-auto font-mono text-xs text-zinc-400">{fmtDate(l.created_at)}</span>
                </div>
                <p className="mt-1.5 text-sm text-zinc-700">
                  操作者 <span className="font-medium text-zinc-800">{l.actor_email ?? "（未知）"}</span>
                  {l.target_email ? (
                    <>
                      {" "}→ 对象 <span className="font-medium text-zinc-800">{l.target_email}</span>
                    </>
                  ) : null}
                  {extra.length > 0 ? (
                    <span className="ml-1 text-xs text-zinc-400">
                      （{extra.map((k) => `${k}: ${String((l.detail as Record<string, unknown>)[k])}`).join("，")}）
                    </span>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
