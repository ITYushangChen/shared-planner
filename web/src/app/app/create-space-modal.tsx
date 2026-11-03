"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { SpaceVisibility } from "@/lib/spaces";
import { railItemClass } from "./rail-class";
import { Modal } from "./ui-modal";

const CreateSpaceForm = dynamic(
  () =>
    import("./create-space-form").then((m) => ({ default: m.CreateSpaceForm })),
  { ssr: false },
);

type Props = {
  iconOnly?: boolean;
  /** 左侧图标轨：白字图标按钮 */
  rail?: boolean;
  defaultVisibility?: SpaceVisibility;
  /** 隐藏底部全宽按钮时用图标触发 */
  hideDefaultTrigger?: boolean;
  /** 默认触发器的文案与样式（样式仅在传入 label 时生效） */
  label?: string;
  className?: string;
};

export function CreateSpaceModal({
  iconOnly = false,
  rail = false,
  defaultVisibility = "private",
  hideDefaultTrigger = false,
  label,
  className,
}: Props) {
  const [open, setOpen] = useState(false);

  const overlay = (
    <Modal open={open} onClose={() => setOpen(false)} title="新建空间">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-900">新建空间</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-zinc-500 hover:text-zinc-800"
        >
          关闭
        </button>
      </div>
      <CreateSpaceForm
        compact
        defaultVisibility={defaultVisibility}
        onCreated={() => setOpen(false)}
      />
    </Modal>
  );

  if (rail) {
    return (
      <>
        <button
          type="button"
          aria-label="新建空间"
          data-tip="新建空间"
          onClick={() => setOpen(true)}
          className={className ?? railItemClass(false)}
        >
          <PlusIcon />
        </button>
        {overlay}
      </>
    );
  }

  if (iconOnly || hideDefaultTrigger) {
    return (
      <>
        <button
          type="button"
          title="新建空间"
          aria-label="新建空间"
          onClick={() => setOpen(true)}
          className={
            className ??
            "inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border-muted)] bg-[var(--surface-muted)] text-[var(--brand-ink)] transition-colors hover:bg-white"
          }
        >
          <PlusIcon />
        </button>
        {overlay}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "w-full rounded-xl bg-zinc-900 px-3 py-2.5 text-left text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 active:scale-[0.99]"
        }
      >
        {label ?? "+ 新建空间"}
      </button>
      {overlay}
    </>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}
