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
    <section className="border-t border-[var(--border-muted)] py-5 first:border-t-0 first:pt-0 last:pb-0">
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

/** 开关：用 role="switch" 表达语义，读屏与键盘都可用 */
export function SettingsToggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200",
        checked
          ? "border-[#2f5f8f] bg-[#2f5f8f]"
          : "border-[var(--border-muted)] bg-[var(--surface-muted)]",
        disabled ? "opacity-40" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        className={[
          "inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200",
          checked ? "translate-x-6" : "translate-x-1",
        ].join(" ")}
      />
    </button>
  );
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
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-muted)] pt-4">
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
