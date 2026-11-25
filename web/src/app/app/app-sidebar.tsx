"use client";

import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { SpaceMemberOption, SpaceNavItem } from "@/lib/todos";
import { Modal } from "./ui-modal";
import dynamic from "next/dynamic";
const CreateSpaceModal = dynamic(
  () =>
    import("./create-space-modal").then((m) => ({ default: m.CreateSpaceModal })),
  { ssr: false, loading: () => null },
);
const JoinSpaceModal = dynamic(
  () =>
    import("./join-space-modal").then((m) => ({ default: m.JoinSpaceModal })),
  { ssr: false, loading: () => null },
);
import { NotificationBell } from "./notification-bell";
import { SpaceKindNav } from "./space-kind-nav";
import { SpaceNavRow } from "./space-nav-row";
import {
  railDividerClass,
  railItemClass,
  railShellClass,
} from "./rail-class";
import { createClient } from "@/lib/supabase/client";
import { prefetchAppRoutes } from "@/lib/soft-nav";
import { useSpaceNavRealtime } from "@/lib/use-space-nav-realtime";

const AiAssistant = dynamic(
  () => import("./ai-assistant").then((m) => ({ default: m.AiAssistant })),
  { ssr: false },
);
const QuickCreateTodo = dynamic(
  () =>
    import("./quick-create-todo").then((m) => ({ default: m.QuickCreateTodo })),
  { ssr: false },
);
const SpacePanelModal = dynamic(
  () =>
    import("./space-panel-modal").then((m) => ({ default: m.SpacePanelModal })),
  { ssr: false },
);
const SidebarUnscheduled = dynamic(
  () =>
    import("./sidebar-unscheduled").then((m) => ({
      default: m.SidebarUnscheduled,
    })),
  { ssr: false },
);

type Props = {
  spaces: SpaceNavItem[];
  displayName?: string | null;
  avatarUrl?: string | null;
  globalUiPrefs?: unknown;
  spacePrefsById?: Record<string, unknown>;
  timezone?: string;
};

export function AppSidebar({
  spaces,
  displayName,
  avatarUrl,
  timezone,
}: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [focusSpaceId, setFocusSpaceId] = useState<string | null>(
    spaces[0]?.id ?? null,
  );
  const [quickSpaceId, setQuickSpaceId] = useState<string | null>(null);
  const [quickMembers, setQuickMembers] = useState<SpaceMemberOption[]>([]);
  const [aiSpace, setAiSpace] = useState<SpaceNavItem | null>(null);
  const [panelMode, setPanelMode] = useState<"invites" | "members" | null>(
    null,
  );
  const [privOpen, setPrivOpen] = useState(true);
  const [pubsOpen, setPubsOpen] = useState(true);
  /** 桌面二级空间栏收起（保留最左图标栏） */
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  useSpaceNavRealtime();

  useEffect(() => {
    try {
      const a = localStorage.getItem("sharetodo-nav-priv-open");
      const b = localStorage.getItem("sharetodo-nav-pubs-open");
      const c = localStorage.getItem("sharetodo-sidebar-collapsed");
      if (a === "0") setPrivOpen(false);
      if (b === "0") setPubsOpen(false);
      if (c === "1") setPanelCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);

  function togglePrivOpen() {
    setPrivOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("sharetodo-nav-priv-open", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function togglePubsOpen() {
    setPubsOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("sharetodo-nav-pubs-open", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function togglePanelCollapsed() {
    setPanelCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(
          "sharetodo-sidebar-collapsed",
          next ? "1" : "0",
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  /** 消息页：自动隐藏二级「空间」栏，让消息内容占满整屏 */
  const onMessagesPage =
    pathname === "/app/notifications" ||
    pathname.startsWith("/app/notifications/");
  /** 二级栏真正隐藏（手动收起 或 处于消息页） */
  const panelHidden = panelCollapsed || onMessagesPage;
  const privateSpaces = spaces.filter((s) => s.visibility !== "public");
  const publicSpaces = spaces.filter((s) => s.visibility === "public");
  const name = displayName || "用户";
  const quickSpace =
    spaces.find((s) => s.id === quickSpaceId) ?? spaces[0] ?? null;
  const quickCanAssign =
    quickSpace?.role === "owner" || quickSpace?.role === "admin";

  // 侧栏快速创建：拉取成员，owner/admin 可指派他人（含公共空间）
  useEffect(() => {
    if (!quickSpaceId) {
      setQuickMembers([]);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    void supabase
      .from("space_members")
      .select("user_id, profiles(display_name, email)")
      .eq("space_id", quickSpaceId)
      .then(({ data }: { data: any[] | null }) => {
        if (cancelled) return;
        setQuickMembers(
          (data ?? []).map((m: any) => {
            const profile = m.profiles as unknown as {
              display_name: string;
              email: string | null;
            } | null;
            return {
              user_id: m.user_id as string,
              display_name: profile?.display_name?.trim() || "成员",
              email: profile?.email ?? null,
            };
          }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [quickSpaceId]);

  const filter = (list: SpaceNavItem[]) => {
    const t = q.trim().toLowerCase();
    if (!t) return list;
    return list.filter((s) => s.name.toLowerCase().includes(t));
  };

  const priv = useMemo(() => filter(privateSpaces), [privateSpaces, q]);
  const pubs = useMemo(() => filter(publicSpaces), [publicSpaces, q]);
  const searching = q.trim().length > 0;
  const searchHits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [] as SpaceNavItem[];
    return spaces.filter((s) => s.name.toLowerCase().includes(t));
  }, [spaces, q]);

  const onOverview = pathname === "/app";
  const onReports =
    pathname === "/app/reports" || pathname.startsWith("/app/reports/");
  const onKnowledge =
    pathname === "/app/knowledge" || pathname.startsWith("/app/knowledge/");
  const onDocs = pathname === "/app/docs" || pathname.startsWith("/app/docs/");
  const onStudy =
    pathname === "/app/study" || pathname.startsWith("/app/study/");
  const onNotify = pathname === "/app/notifications";
  const onProfile = pathname.startsWith("/app/settings");

  const spaceIdFromPath = pathname.startsWith("/app/spaces/")
    ? pathname.split("/")[3] || null
    : null;

  useEffect(() => {
    if (!focusSpaceId && spaces[0]) setFocusSpaceId(spaces[0].id);
  }, [spaces, focusSpaceId]);

  useEffect(() => {
    if (spaceIdFromPath) setFocusSpaceId(spaceIdFromPath);
  }, [spaceIdFromPath]);

  const focusSpace =
    spaces.find((s) => s.id === focusSpaceId) ?? spaces[0] ?? null;

  useEffect(() => {
    prefetchAppRoutes(
      (href) => router.prefetch(href),
      spaces.map((s) => s.id),
    );
  }, [router, spaces]);

  return (
    <>
      {/* 最左图标栏：只负责「去哪个页面」，视图切换已移到内容区顶部 */}
      <aside className={railShellClass}>
        <Link
          href="/app/settings"
          aria-label="设置"
          data-tip="设置"
          prefetch
          className={railItemClass(onProfile)}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              className="h-8 w-8 rounded-full object-cover ring-2 ring-white"
            />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--rail-fg-strong)] text-xs font-semibold text-white ring-2 ring-white">
              {name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </Link>
        <Link
          href="/app?view=calendar&range=week"
          aria-label="总览工作区"
          data-tip="总览"
          prefetch
          className={railItemClass(onOverview)}
        >
          <RailIconOverview />
        </Link>
        <Link
          href="/app/notifications"
          aria-label="消息"
          data-tip="消息"
          prefetch
          className={railItemClass(onNotify)}
        >
          <NotificationBell iconOnly rail subscribe />
        </Link>

        <Link
          href="/app/reports"
          aria-label="报告中心"
          data-tip="报告"
          prefetch
          className={railItemClass(onReports)}
        >
          <RailIconReport />
        </Link>

        <Link
          href="/app/knowledge"
          aria-label="知识板块"
          data-tip="知识"
          prefetch
          className={railItemClass(onKnowledge)}
        >
          <RailIconKnowledge />
        </Link>

        <Link
          href="/app/docs"
          aria-label="资料"
          data-tip="资料"
          prefetch
          className={railItemClass(onDocs)}
        >
          <RailIconDocs />
        </Link>

        <Link
          href="/app/study"
          aria-label="学习计划"
          data-tip="学习"
          prefetch
          className={railItemClass(onStudy)}
        >
          <RailIconStudy />
        </Link>

        <div className={railDividerClass} />

        {/* 展开空间列表：紧跟在「报告」下面；只在二级栏收起时出现（展开时「收起」按钮在栏自己头上） */}
        {panelCollapsed ? (
          <button
            type="button"
            aria-label="展开空间列表"
            data-tip="展开空间列表"
            aria-pressed={false}
            onClick={togglePanelCollapsed}
            className={railItemClass(false)}
          >
            <RailIconPanelToggle collapsed />
          </button>
        ) : null}

        <div className="mt-auto flex w-full flex-col items-center gap-1.5">
          <div className={railDividerClass} />
          {/* 动作组：AI → 新建 → 加入（按使用频率从上到下） */}
          <button
            type="button"
            aria-label="AI 助手"
            data-tip="AI 助手"
            disabled={spaces.length === 0}
            onClick={() => {
              const target = focusSpace ?? spaces[0];
              if (target) setAiSpace(target);
            }}
            className={railItemClass(false) + " disabled:cursor-not-allowed disabled:opacity-40"}
          >
            <RailIconSpark />
          </button>
          <CreateSpaceModal rail />
          <JoinSpaceModal rail />
        </div>
      </aside>

      {/* 二级导航（半透明）；可收起，不拖拽改宽 */}
      <aside
        className={[
          "hidden h-dvh sticky top-0 shrink-0 flex-col border-r border-[var(--border-muted)]/80 bg-white/75 backdrop-blur-md transition-[width,opacity] duration-200 md:flex",
          panelHidden
            ? "w-0 overflow-hidden border-r-0 opacity-0 pointer-events-none"
            : "w-64 opacity-100",
        ].join(" ")}
        aria-hidden={panelHidden}
      >
        {/* 头部：只留搜索 + 收起；「空间」标题与下方分组重复，已删 */}
        <div className="shrink-0 border-b border-[var(--border-muted)]/80 px-2 py-2">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
                <RailIconSearch />
              </span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索空间"
                className="w-full rounded-lg border border-[var(--border-muted)] bg-white py-2 pl-8 pr-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
              />
            </div>
            <button
              type="button"
              title="收起空间列表"
              aria-label="收起空间列表"
              onClick={togglePanelCollapsed}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--brand-ink)]"
            >
              <RailIconPanelToggle collapsed={false} />
            </button>
          </div>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          {/* 总览 / 报告 只保留最左图标栏一个入口：这里再放一遍会出现「同一页面两处高亮」 */}

          {searching ? (
            <div className="space-y-0.5">
              {searchHits.length === 0 ? (
                <p className="px-2 py-2 text-sm text-[var(--text-muted)]">
                  无匹配空间
                </p>
              ) : (
                searchHits.map((s) => (
                  <SpaceNavRow
                    key={s.id}
                    space={s}
                    hideSubtitle
                    onQuickCreate={setQuickSpaceId}
                  />
                ))
              )}
            </div>
          ) : (
            <>
              <SectionHeader
                label="我的空间"
                open={privOpen}
                onToggle={togglePrivOpen}
                addSlot={
                  <CreateSpaceModal
                    defaultVisibility="private"
                    hideDefaultTrigger
                    className={sectionAddBtnClass}
                  />
                }
              />
              {privOpen ? (
                <div className="space-y-0.5 pl-1">
                  <SpaceKindNav
                    spaces={priv}
                    storagePrefix="sharetodo-nav-priv-kind"
                    emptyText="还没有私人空间，点上方 + 新建"
                    flat
                    hideSubtitle
                    onQuickCreate={setQuickSpaceId}
                  />
                </div>
              ) : null}

              <SectionHeader
                label="公共空间"
                open={pubsOpen}
                onToggle={togglePubsOpen}
                addSlot={
                  <CreateSpaceModal
                    defaultVisibility="public"
                    hideDefaultTrigger
                    className={sectionAddBtnClass}
                  />
                }
              />
              {pubsOpen ? (
                <div className="space-y-0.5 pl-1">
                  <SpaceKindNav
                    spaces={pubs}
                    storagePrefix="sharetodo-nav-pubs-kind"
                    emptyText="还没有公共空间，点上方 + 新建"
                    flat
                    hideSubtitle
                    onQuickCreate={setQuickSpaceId}
                  />
                </div>
              ) : null}
            </>
          )}
        </nav>
        {!panelHidden ? (
          <div className="flex max-h-[42%] shrink-0 flex-col overflow-hidden">
            <SidebarUnscheduled spaces={spaces} />
          </div>
        ) : null}
      </aside>


      {quickSpace ? (
        <Modal
          open={Boolean(quickSpaceId)}
          onClose={() => setQuickSpaceId(null)}
          title="快速创建"
          zClass="z-[80]"
          overlayClassName="flex items-start justify-center overflow-y-auto p-4 pt-[8vh]"
          className="w-full max-w-lg rounded-xl border border-[var(--border-muted)] bg-white p-4 shadow-xl"
        >
          <div>
          <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-[var(--brand-ink)]">
                    快速创建
                  </h2>
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                    onClick={() => setQuickSpaceId(null)}
                  >
                    关闭
                  </button>
                </div>
                <QuickCreateTodo
                  key={quickSpace.id}
                  spaces={spaces}
                  defaultSpaceId={quickSpace.id}
                  members={quickMembers}
                  canAssign={quickCanAssign}
                  bare
                  onCreated={() => setQuickSpaceId(null)}
                />
          </div>
        </Modal>
      ) : null}

      {panelMode ? (
        <SpacePanelModal
          mode={panelMode}
          spaces={spaces}
          initialSpaceId={focusSpaceId}
          onClose={() => setPanelMode(null)}
        />
      ) : null}

      <Modal
        open={Boolean(aiSpace)}
        onClose={() => setAiSpace(null)}
        title={aiSpace ? `AI 助手 · ${aiSpace.name}` : "AI 助手"}
        zClass="z-[80]"
        overlayClassName="flex items-start justify-center overflow-y-auto p-4 pt-[6vh]"
        className="w-full max-w-2xl rounded-xl border border-[var(--border-muted)] bg-white p-4 shadow-xl"
      >
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--brand-ink)]">
              AI 助手 · {aiSpace?.name}
            </h2>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              onClick={() => setAiSpace(null)}
            >
              关闭
            </button>
          </div>
          {aiSpace ? (
            <AiAssistant
              key={aiSpace.id}
              spaces={spaces}
              defaultSpaceId={aiSpace.id}
              timezone={timezone}
              plain
            />
          ) : null}
        </div>
      </Modal>
    </>
  );
}

/** 分组标题：左侧三角承担折叠，替代原来常驻的「收起 / 展开」两个文字按钮 */
function SectionHeader({
  label,
  open,
  onToggle,
  addSlot,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  addSlot?: ReactNode;
}) {
  return (
    <div className="mt-4 flex w-full items-center gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-[11px] font-semibold tracking-[0.06em] text-[var(--text-muted)] transition-colors hover:text-[var(--brand-ink)]"
      >
        <span
          className={[
            "shrink-0 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          ].join(" ")}
        >
          <RailIconChevron />
        </span>
        <span className="truncate">{label}</span>
      </button>
      {addSlot}
    </div>
  );
}

const sectionAddBtnClass =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--brand-ink)]";

/** collapsed=true：面板已收起，图标示意「向右展开」 */
function RailIconPanelToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M9 4v16" stroke="currentColor" strokeWidth="1.6" />
      <path
        d={collapsed ? "M14 9l3 3-3 3" : "M16 9l-3 3 3 3"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RailIconOverview() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-5v-6H10v6H5a1 1 0 01-1-1v-9.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RailIconReport() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 20v-8M12 20V5M19 20v-5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M3 20h18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RailIconKnowledge() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 6.5C10.5 5.2 8.4 4.5 6 4.5H4.5A1.5 1.5 0 003 6v12a1.5 1.5 0 001.5 1.5H6c2.4 0 4.5.7 6 1.5V6.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M12 6.5C13.5 5.2 15.6 4.5 18 4.5h1.5A1.5 1.5 0 0121 6v12a1.5 1.5 0 01-1.5 1.5H18c-2.4 0-4.5.7-6 1.5V6.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 6.5v14.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function RailIconDocs() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 3h7l4 4v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M14 3v4h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9 12h6M9 16h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RailIconStudy() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 9l9-4.5L21 9l-9 4.5L3 9z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 11v4.2c0 1.3 2.5 2.3 5.5 2.3s5.5-1 5.5-2.3V11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 9v5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RailIconChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RailIconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M16.5 16.5L21 21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** AI 助手：星芒图标（与其他 rail 图标同为线性风格，尺寸/线宽由 globals.css 统一） */
function RailIconSpark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M11 3.4 12.8 8.2 17.6 10 12.8 11.8 11 16.6 9.2 11.8 4.4 10 9.2 8.2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M18 14.4 18.7 16.3 20.6 17 18.7 17.7 18 19.6 17.3 17.7 15.4 17 17.3 16.3z"
        fill="currentColor"
        opacity="0.75"
      />
    </svg>
  );
}

