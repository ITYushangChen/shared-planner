"use client";

import { CreateSpaceModal } from "./create-space-modal";
import { JoinSpaceModal } from "./join-space-modal";

/**
 * 新用户首登引导。
 *
 * 此前没有任何空间时，主区是一个空日历 + 侧栏一句「暂无私人空间」，
 * 用户不知道下一步该干什么。这里给出明确的两个入口。
 */
export function EmptySpaceGuide() {
  return (
    <section className="mb-2 flex flex-col items-start gap-3 rounded-2xl border border-dashed border-[var(--border-muted)] bg-[var(--surface-muted)] px-5 py-6">
      <div>
        <h2 className="text-base font-semibold text-[var(--brand-ink)]">
          还没有任何空间
        </h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          空间是协作的容器：可以先建一个自己的私人空间，也可以凭邀请码加入别人的空间。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <CreateSpaceModal
          label="新建私人空间"
          className="rounded-xl bg-[#2f5f8f] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#15487d]"
        />
        <JoinSpaceModal className="rounded-xl border border-[#2f5f8f]/55 bg-white px-4 py-2 text-sm font-medium text-[#2f5f8f] transition-colors hover:bg-[#e8f0f7]" />
      </div>
    </section>
  );
}
