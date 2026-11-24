"use client";

import { useCallback, useEffect, useState } from "react";

type ErrorRow = {
  id: string;
  message: string;
  operation: string | null;
  level: string;
  meta: Record<string, unknown>;
  created_at: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const levelBadge = (level: string) =>
  level === "warn"
    ? "bg-amber-50 text-amber-600"
    : level === "info"
      ? "bg-blue-50 text-blue-600"
      : "bg-red-50 text-red-600";

/**
 * 管理后台「错误日志」面板：展示报错信息、报错操作（来源）与时间。
 * 支持展开查看附加上下文（页面 URL / 堆栈）。
 */
export function AdminErrorsPanel() {
  const [logs, setLogs] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/auth/admin-errors", { credentials: "same-origin" });
      const data = (await res.json()) as { logs?: ErrorRow[]; error?: string };
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
          暂无错误日志
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
          {logs.map((l) => {
            const metaKeys = Object.keys(l.meta ?? {});
            const expanded = !!open[l.id];
            return (
              <li key={l.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${levelBadge(l.level)}`}>
                    {l.level}
                  </span>
                  <span className="shrink-0 rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">
                    {l.operation ?? "未标注来源"}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-xs text-zinc-400">{fmtDate(l.created_at)}</span>
                </div>
                <p className="mt-1.5 break-all text-sm text-zinc-800">{l.message}</p>
                {metaKeys.length > 0 ? (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={() => setOpen((o) => ({ ...o, [l.id]: !o[l.id] }))}
                      className="text-xs text-[#185FA5] hover:underline"
                    >
                      {expanded ? "收起" : "展开"}详情（{metaKeys.length}）
                    </button>
                    {expanded ? (
                      <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-600">
                        {JSON.stringify(l.meta, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
