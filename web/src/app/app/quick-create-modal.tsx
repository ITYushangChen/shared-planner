"use client";

import { useState, type ReactNode } from "react";
import type { SpaceMemberOption, SpaceNavItem } from "@/lib/todos";
import { Modal } from "./ui-modal";
import { QuickCreateTodo } from "./quick-create-todo";
import { toggleBtnClass } from "./toggle-btn-class";

type Props = {
  spaces: SpaceNavItem[];
  defaultSpaceId?: string;
  members?: SpaceMemberOption[];
  membersBySpace?: Record<string, SpaceMemberOption[]>;
  canAssign?: boolean;
  allowOverview?: boolean;
  buttonClassName?: string;
  label?: string;
  /** 自定义触发器；提供后忽略默认按钮文案 */
  trigger?: ReactNode;
  /** 仅图标 + */
  iconOnly?: boolean;
};

export function QuickCreateModal({
  spaces,
  defaultSpaceId,
  members,
  membersBySpace,
  canAssign,
  allowOverview = false,
  buttonClassName,
  label = "快速创建",
  trigger,
  iconOnly = false,
}: Props) {
  const [open, setOpen] = useState(false);

  if (spaces.length === 0) return null;

  const overlay = (
    <Modal open={open} onClose={() => setOpen(false)} title="快速创建待办" variant="bottom">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-900">快速创建待办</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-zinc-500 hover:text-zinc-800"
        >
          关闭
        </button>
      </div>
      <QuickCreateTodo
        spaces={spaces}
        defaultSpaceId={defaultSpaceId}
        members={members}
        membersBySpace={membersBySpace}
        canAssign={canAssign}
        allowOverview={allowOverview}
        bare
        onCreated={() => setOpen(false)}
      />
    </Modal>
  );

  return (
    <>
      {trigger ? (
        <span
          role="button"
          tabIndex={0}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className="inline-flex"
        >
          {trigger}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="快速创建"
          aria-label="快速创建"
          className={
            buttonClassName ??
            (iconOnly
              ? "inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--border-muted)] bg-[var(--surface-muted)] text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-white hover:text-[var(--brand-ink)]"
              : toggleBtnClass(open))
          }
        >
          {iconOnly ? "+" : label}
        </button>
      )}
      {overlay}
    </>
  );
}
