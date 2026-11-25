"use client";

import type { SpaceNavItem } from "@/lib/todos";
import { SpaceNavRow } from "../space-nav-row";
import { CreateSpaceModal } from "../create-space-modal";

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-1.5 pb-2 pt-4 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-muted)]">
      {children}
    </p>
  );
}

/** 空间总览列表页：我的空间（私有）/ 公共空间 分组，复用侧栏同款 SpaceNavRow */
export function SpacesOverview({ spaces }: { spaces: SpaceNavItem[] }) {
  const privateSpaces = spaces.filter((s) => s.visibility !== "public");
  const publicSpaces = spaces.filter((s) => s.visibility === "public");

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-4 md:px-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--text-muted)]">{spaces.length} 个空间</p>
        <CreateSpaceModal iconOnly />
      </div>

      {spaces.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border-muted)] py-16 text-center">
          <p className="text-sm font-medium text-[var(--brand-ink)]">
            还没有空间
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            点击右上角 ＋ 创建你的第一个空间
          </p>
        </div>
      ) : (
        <>
          {privateSpaces.length > 0 ? (
            <section>
              <SectionLabel>我的空间</SectionLabel>
              <div className="space-y-1">
                {privateSpaces.map((s) => (
                  <SpaceNavRow key={s.id} space={s} />
                ))}
              </div>
            </section>
          ) : null}

          {publicSpaces.length > 0 ? (
            <section>
              <SectionLabel>公共空间</SectionLabel>
              <div className="space-y-1">
                {publicSpaces.map((s) => (
                  <SpaceNavRow key={s.id} space={s} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
