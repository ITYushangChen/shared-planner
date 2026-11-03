"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "../ui-modal";
import { SettingsRow, SettingsSection, fieldClass } from "./settings-ui";

type Impact = {
  createdTodos: number;
  otherSpaces: number;
  ownedSpaces: number;
  transferSpaces: number;
  deleteSpaces: number;
};

/**
 * 注销账号。
 *
 * 这是不可逆操作，所以做成「先看清后果 → 再输入邮箱确认」两步：
 * 打开弹窗时先向服务端要一份影响面（会删多少、转让多少），
 * 用户看到真实数字、且输入的邮箱与当前账号完全一致后，确认按钮才可用。
 */
export function DeleteAccountPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [email, setEmail] = useState("");
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState("");

  const loadImpact = useCallback(async () => {
    setLoading(true);
    setMsg("");
    try {
      const res = await fetch("/auth/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as {
        impact?: Impact;
        email?: string;
        error?: string;
      };
      if (!res.ok) {
        setMsg(json.error ?? "加载失败，请稍后重试");
        return;
      }
      setImpact(json.impact ?? null);
      setEmail(json.email ?? "");
    } catch {
      setMsg("网络异常，请检查网络后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadImpact();
    else {
      setTyped("");
      setMsg("");
    }
  }, [open, loadImpact]);

  const match = email !== "" && typed.trim().toLowerCase() === email.toLowerCase();

  async function onDelete() {
    if (!match || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/auth/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail: typed.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setMsg(json.error ?? "注销失败，请稍后重试");
        setBusy(false);
        return;
      }
      const supabase = createClient();
      await supabase.auth.signOut();
      router.replace("/login?deleted=1");
    } catch {
      setMsg("网络异常，注销未完成，请重试");
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection
        title="注销账号"
        desc="永久删除账号及其数据，不可恢复。建议先导出需要保留的任务。"
      >
        <SettingsRow
          label="删除账号"
          hint="需要邮箱二次确认；协作空间会自动转让给其他成员"
        >
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
          >
            注销账号…
          </button>
        </SettingsRow>
      </SettingsSection>

      <Modal open={open} onClose={() => setOpen(false)} title="注销账号">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-red-600">注销账号</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm text-[var(--text-muted)] hover:text-[var(--brand-ink)]"
            >
              关闭
            </button>
          </div>

          {loading ? (
            <p className="py-6 text-sm text-[var(--text-muted)]">
              正在统计影响范围…
            </p>
          ) : impact ? (
            <>
              <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800">
                此操作不可撤销。删除后你将立即退出登录，且无法用该邮箱找回任何数据。
              </p>
              <ul className="mb-3 space-y-1.5 text-sm text-[var(--text-secondary)]">
                <li>
                  {impact.createdTodos > 0 ? (
                    <>
                      · 你创建的
                      <strong className="text-[var(--brand-ink)]">
                        {" "}
                        {impact.createdTodos} 条任务
                      </strong>
                      会被删除
                      {impact.otherSpaces > 0 ? (
                        <span className="text-[var(--text-muted)]">
                          （含在他人空间创建的，涉及 {impact.otherSpaces} 个空间）
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <>· 你没有创建过任务，不会删除他人空间里的任何内容</>
                  )}
                </li>
                {impact.transferSpaces > 0 ? (
                  <li>
                    · 你拥有的 {impact.transferSpaces}{" "}
                    个协作空间会转让给其他成员，不会丢失
                  </li>
                ) : null}
                {impact.deleteSpaces > 0 ? (
                  <li>
                    · 你独自使用的 {impact.deleteSpaces}{" "}
                    个空间及其全部内容会被删除
                  </li>
                ) : null}
              </ul>
              <label className="mb-3 block text-xs text-[var(--text-muted)]">
                请输入邮箱 <span className="font-medium">{email}</span> 以确认
                <input
                  type="email"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={email}
                  autoComplete="off"
                  className={`mt-1 ${fieldClass()}`}
                />
              </label>
              {msg ? (
                <p className="mb-2 text-xs text-red-600">{msg}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-lg border border-[var(--border-muted)] bg-white px-3 py-2 text-sm font-medium text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!match || busy}
                  onClick={() => void onDelete()}
                  className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40"
                >
                  {busy ? "注销中…" : "确认注销"}
                </button>
              </div>
            </>
          ) : (
            <p className="py-6 text-sm text-red-600">{msg || "加载失败"}</p>
          )}
        </div>
      </Modal>
    </>
  );
}
