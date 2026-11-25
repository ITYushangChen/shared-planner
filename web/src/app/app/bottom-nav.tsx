"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import type { SpaceNavItem } from "@/lib/todos";
import { Modal } from "./ui-modal";

const QuickCreateTodo = dynamic(
  () =>
    import("./quick-create-todo").then((m) => ({ default: m.QuickCreateTodo })),
  { ssr: false },
);
const CreateSpaceForm = dynamic(
  () =>
    import("./create-space-form").then((m) => ({ default: m.CreateSpaceForm })),
  { ssr: false },
);

type Props = {
  spaces: SpaceNavItem[];
};

type TabDef = {
  href: string;
  label: string;
  active: boolean;
  icon: React.ReactNode;
};

/** 底部导航：首页 · 日历 · ＋(悬浮) · 空间 · 我的（TickTick 式，全尺寸统一） */
export function BottomNav({ spaces }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [composeOpen, setComposeOpen] = useState(false);
  const [menu, setMenu] = useState<"todo" | "space" | null>(null);
  const composeRef = useRef<HTMLDivElement>(null);

  const view = searchParams.get("view");
  const onHome = pathname === "/app";
  const homeActive = onHome && view !== "calendar";
  const calActive = onHome && view === "calendar";
  const spacesActive =
    pathname === "/app/spaces" || pathname.startsWith("/app/spaces/");
  const meActive =
    pathname === "/app/settings" ||
    pathname === "/app/profile" ||
    pathname.startsWith("/app/notifications");

  useEffect(() => {
    if (!composeOpen) return;
    function onDoc(e: MouseEvent) {
      if (!composeRef.current?.contains(e.target as Node)) {
        setComposeOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [composeOpen]);

  function openMenu(kind: "todo" | "space") {
    setComposeOpen(false);
    setMenu(kind);
  }

  const tabs: TabDef[] = [
    {
      href: "/app?view=list",
      label: "首页",
      active: homeActive,
      icon: <HomeIcon />,
    },
    {
      href: "/app?view=calendar",
      label: "日历",
      active: calActive,
      icon: <CalendarIcon />,
    },
  ];

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-muted)] bg-white/95 backdrop-blur-md md:hidden">
        <div className="mx-auto grid h-16 w-full max-w-[1200px] grid-cols-5 px-2">
          {tabs.slice(0, 2).map((t) => (
            <TabItem key={t.label} tab={t} />
          ))}

          {/* 中间悬浮 ＋ */}
          <div ref={composeRef} className="relative flex items-center justify-center">
            <button
              type="button"
              aria-label="新建"
              aria-expanded={composeOpen}
              onClick={() => setComposeOpen((v) => !v)}
              className="-mt-6 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--brand)] text-white shadow-lg shadow-[var(--brand)]/30 transition-transform duration-150 hover:bg-[#0c447c] active:scale-95"
            >
              <PlusIcon />
            </button>

            {composeOpen ? (
              <div className="absolute bottom-16 left-1/2 z-50 w-44 -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--border-muted)] bg-white py-1 shadow-xl">
                <button
                  type="button"
                  onClick={() => openMenu("todo")}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-[var(--brand-ink)] transition-colors hover:bg-[var(--surface-muted)]"
                >
                  <TodoIcon />
                  新建待办
                </button>
                <button
                  type="button"
                  onClick={() => openMenu("space")}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-[var(--brand-ink)] transition-colors hover:bg-[var(--surface-muted)]"
                >
                  <SpaceIcon />
                  新建空间
                </button>
              </div>
            ) : null}
          </div>

          {[
            {
              href: "/app/spaces",
              label: "空间",
              active: spacesActive,
              icon: <SpaceIcon />,
            },
            {
              href: "/app/settings",
              label: "我的",
              active: meActive,
              icon: <MeIcon />,
            },
          ].map((t) => (
            <TabItem key={t.label} tab={t} />
          ))}
        </div>
      </nav>

      {/* 新建待办 */}
      <Modal
        open={menu === "todo"}
        onClose={() => setMenu(null)}
        title="新建待办"
        variant="bottom"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--brand-ink)]">
            新建待办
          </h2>
          <button
            type="button"
            onClick={() => setMenu(null)}
            className="rounded px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            关闭
          </button>
        </div>
        <QuickCreateTodo
          spaces={spaces}
          allowOverview
          bare
          onCreated={() => setMenu(null)}
        />
      </Modal>

      {/* 新建空间 */}
      <Modal
        open={menu === "space"}
        onClose={() => setMenu(null)}
        title="新建空间"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--brand-ink)]">
            新建空间
          </h2>
          <button
            type="button"
            onClick={() => setMenu(null)}
            className="rounded px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            关闭
          </button>
        </div>
        <CreateSpaceForm
          compact
          defaultVisibility="private"
          onCreated={() => setMenu(null)}
        />
      </Modal>
    </>
  );
}

function TabItem({ tab }: { tab: TabDef }) {
  return (
    <Link
      href={tab.href}
      prefetch
      className={[
        "flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
        tab.active
          ? "text-[var(--brand)]"
          : "text-[var(--text-muted)] hover:text-[var(--brand-ink)]",
      ].join(" ")}
    >
      <span className="flex h-6 w-6 items-center justify-center">
        {tab.icon}
      </span>
      {tab.label}
    </Link>
  );
}

function HomeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5M9 21v-6h6v6"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 3v3m8-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"
      />
    </svg>
  );
}

function SpaceIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"
      />
    </svg>
  );
}

function MeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

function TodoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5 text-[var(--brand)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"
      />
    </svg>
  );
}
