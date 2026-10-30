"use client";

import type { ReactNode } from "react";
import { primaryBtnClass, secondaryBtnClass } from "../ui-btn-class";

/** 分区卡片：标题 + 说明 + 若干行（行之间是细分割线） */
export function SettingsSection({
  title,
  desc,
  children,
  danger = false,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      className={[
        "rounded-xl border bg-white p-5",
        danger ? "border-red-200" : "border-[var(--border-muted)]",
      ].join(" ")}
    >
      <header>
        <h2
          className={[
            "text-sm font-semibold",
            danger ? "text-red-600" : "text-[var(--brand-ink)]",
          ].join(" ")}
        >
          {title}
        </h2>
        {desc ? (
          <p className="mt-1 text-xs text-[var(--text-muted)]">{desc}</p>
        ) : null}
      </header>
      <div className="mt-4 flex flex-col divide-y divide-[var(--border-muted)]">
        {children}
      </div>
    </section>
  );
}

/** 一行设置：左侧名称+说明，右侧控件 */
export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)] md:items-center md:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--brand-ink)]">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{hint}</p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** 输入框统一样式 */
export function fieldClass(disabled = false) {
  return [
    "w-full rounded-lg border border-[var(--border-muted)] bg-white px-3 py-2 text-sm",
    "text-[var(--brand-ink)] outline-none transition-colors focus:border-[#2f5f8f]",
    disabled ? "bg-[var(--surface-muted)] text-[var(--text-muted)]" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** 底部保存栏：有改动才亮按钮，保存后显示结果 */
export function SettingsFooter({
  dirty,
  saving,
  msg,
  onReset,
  saveText = "保存更改",
}: {
  dirty: boolean;
  saving: boolean;
  msg: string;
  onReset: () => void;
  saveText?: string;
}) {
  return (
    <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] mt-4 flex flex-wrap md:bottom-0 items-center justify-between gap-3 rounded-xl border border-[var(--border-muted)] bg-white/95 px-4 py-3 shadow-[0_-6px_16px_-12px_rgba(0,0,0,0.35)] backdrop-blur">
      <p className="text-xs text-[var(--text-muted)]">
        {dirty ? "有未保存的更改" : msg || "暂无更改"}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onReset}
          disabled={!dirty || saving}
          className={`${secondaryBtnClass()} disabled:opacity-40`}
        >
          放弃
        </button>
        <button
          type="submit"
          disabled={!dirty || saving}
          className={`${primaryBtnClass()} disabled:opacity-40`}
        >
          {saving ? "保存中…" : saveText}
        </button>
      </div>
    </div>
  );
}
