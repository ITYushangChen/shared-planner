"use client";

import {
  startTransition,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  const searchParams = useSearchParams();
  const [q, setQ] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [spaceToast, setSpaceToast] = useState<"private" | "public" | null>(
    null,
  );
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
  const overviewViewRaw = searchParams.get("view");
  const overviewView =
    overviewViewRaw === "boards"
      ? "boards"
      : overviewViewRaw === "list"
        ? "list"
        : "calendar";
  const onOverviewPage = pathname === "/app";
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
  const onSpaces = pathname.startsWith("/app/spaces");

  const spaceIdFromPath = pathname.startsWith("/app/spaces/")
    ? pathname.split("/")[3] || null
    : null;

  const spaceViewRaw = searchParams.get("view");
  const spaceView =
    spaceViewRaw === "boards" || spaceViewRaw === "list"
      ? spaceViewRaw
      : "calendar";

  useEffect(() => {
    setDrawerOpen(false);
    setSpaceToast(null);
  }, [pathname]);

  useEffect(() => {
    if (!focusSpaceId && spaces[0]) setFocusSpaceId(spaces[0].id);
  }, [spaces, focusSpaceId]);

  useEffect(() => {
    if (spaceIdFromPath) setFocusSpaceId(spaceIdFromPath);
  }, [spaceIdFromPath]);

  const focusSpace =
    spaces.find((s) => s.id === focusSpaceId) ?? spaces[0] ?? null;
  const canManageAny = spaces.some(
    (s) => s.role === "owner" || s.role === "admin",
  );

  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  useEffect(() => {
    prefetchAppRoutes(
      (href) => router.prefetch(href),
      spaces.map((s) => s.id),
    );
  }, [router, spaces]);

  function softPush(href: string, opts?: { refresh?: boolean }) {
    startTransition(() => {
      router.push(href);
      if (opts?.refresh) router.refresh();
    });
  }

  /** 在空间页则切该空间视图；否则进总览 */
  function goAppView(view: "boards" | "calendar" | "list") {
    setDrawerOpen(false);
    if (spaceIdFromPath) {
      const params = new URLSearchParams();
      const assignee = searchParams.get("assignee");
      const range = searchParams.get("range");
      if (assignee) params.set("assignee", assignee);
      if (range) params.set("range", range);
      else params.set("range", "week");
      params.set("view", view);
      softPush(`/app/spaces/${spaceIdFromPath}?${params.toString()}`);
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", view);
    if (!params.get("range")) params.set("range", "week");
    const q = params.toString();
    softPush(q ? `/app?${q}` : "/app");
  }

  function goOverviewRange(key: "day" | "week" | "month") {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", key);
    if (!params.get("view")) params.set("view", "calendar");
    const q = params.toString();
    // 空间页内切换日周月，留在当前空间
    if (spaceIdFromPath) {
      softPush(`/app/spaces/${spaceIdFromPath}?${q}`);
      return;
    }
    softPush(q ? `/app?${q}` : "/app");
  }

  /** 无 range 时默认周 */
  const overviewRange =
    searchParams.get("range") === "day" ||
    searchParams.get("range") === "month"
      ? searchParams.get("range")
      : "week";

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

      {/* 移动端顶栏：菜单 + 消息铃铛 + 标题 */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center gap-2 border-b border-[var(--border-muted)] bg-white/95 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-md md:hidden">
        <button
          type="button"
          title="打开菜单"
          aria-label="打开菜单"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
          onClick={() => setDrawerOpen(true)}
        >
          <MobileMenuIcon />
        </button>
        <NotificationBell iconOnly subscribe />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--brand-ink)]">
          {onOverviewPage || spaceIdFromPath
            ? (spaceIdFromPath ? spaceView : overviewView) === "calendar"
              ? "日历"
              : (spaceIdFromPath ? spaceView : overviewView) === "list"
                ? "四象限待办"
                : "四象限"
            : onSpaces
              ? "空间"
              : onNotify
                ? "消息"
                : onProfile
                  ? "我的"
                  : onReports
                    ? "报告"
                    : onKnowledge
                      ? "知识"
                      : onDocs
                        ? "资料"
                        : onStudy
                          ? "学习"
                  : "ShareTodo"}
        </p>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t border-[var(--border-muted)] bg-white px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
        {/* 时间粒度胶囊分段：日/周/月（仅手机版） */}
        <div
          className="flex flex-1 items-center gap-0.5 rounded-full bg-[var(--surface-muted)] p-1"
          role="group"
          aria-label="时间范围"
        >
          {(
            [
              ["day", "日"],
              ["week", "周"],
              ["month", "月"],
            ] as const
          ).map(([key, label]) => {
            const active =
              (onOverviewPage || Boolean(spaceIdFromPath)) &&
              overviewRange === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => goOverviewRange(key)}
                className={[
                  "flex-1 rounded-full py-1.5 text-sm font-medium transition-all duration-200",
                  active
                    ? "bg-white text-[var(--brand-ink)] shadow-sm"
                    : "text-[var(--text-secondary)]",
                ].join(" ")}
              >
                {label}
              </button>
            );
          })}
        </div>
        <Link
          href="/app/settings"
          prefetch
          className={[
            "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors duration-200",
            onProfile
              ? "font-bold text-[var(--brand-ink)]"
              : "text-[var(--text-muted)]",
          ].join(" ")}
        >
          设置
        </Link>
      </nav>

      <Modal
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="菜单"
        variant="left"
        zClass="z-[70] md:hidden"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-muted)] px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
                  <p className="text-base font-bold text-[var(--brand-ink)]">
                    菜单
                  </p>
                  <button
                    type="button"
                    className="rounded-lg px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                    onClick={() => setDrawerOpen(false)}
                  >
                    关闭
                  </button>
                </div>

                {/* 顶部分览：在空间内则切该空间视图，否则总览 */}
                <div className="flex items-center justify-around gap-1 border-b border-[var(--border-muted)] px-2 py-3">
                  <button
                    type="button"
                    onClick={() => goAppView("boards")}
                    className={drawerViewBtn(
                      spaceIdFromPath
                        ? spaceView === "boards"
                        : onOverviewPage && overviewView === "boards",
                    )}
                  >
                    <DrawerIconBoards />
                    <span>四象限</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => goAppView("calendar")}
                    className={drawerViewBtn(
                      spaceIdFromPath
                        ? spaceView === "calendar"
                        : onOverviewPage && overviewView === "calendar",
                    )}
                  >
                    <DrawerIconCalendar />
                    <span>日历</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => goAppView("list")}
                    className={drawerViewBtn(
                      spaceIdFromPath
                        ? spaceView === "list"
                        : onOverviewPage && overviewView === "list",
                    )}
                  >
                    <DrawerIconList />
                    <span>四象限待办</span>
                  </button>
                </div>

                <div className="border-b border-[var(--border-muted)] px-3 py-2">
                  <button
                    type="button"
                    className={[
                      "mb-2 w-full rounded-xl px-3 py-2.5 text-left text-sm font-semibold",
                      onOverviewPage
                        ? "bg-brand-soft text-brand"
                        : "text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]",
                    ].join(" ")}
                    onClick={() => {
                      setDrawerOpen(false);
                      softPush("/app?view=calendar&range=week");
                    }}
                  >
                    总览工作区
                  </button>
                  <button
                    type="button"
                    className={[
                      "mb-2 w-full rounded-xl px-3 py-2.5 text-left text-sm font-semibold",
                      onReports
                        ? "bg-brand-soft text-brand"
                        : "text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]",
                    ].join(" ")}
                    onClick={() => {
                      setDrawerOpen(false);
                      softPush("/app/reports");
                    }}
                  >
                    报告中心
                  </button>
                  <button
                    type="button"
                    className={[
                      "mb-2 w-full rounded-xl px-3 py-2.5 text-left text-sm font-semibold",
                      onKnowledge
                        ? "bg-brand-soft text-brand"
                        : "text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]",
                    ].join(" ")}
                    onClick={() => {
                      setDrawerOpen(false);
                      softPush("/app/knowledge");
                    }}
                  >
                    知识板块
                  </button>
                  <button
                    type="button"
                    className={[
                      "mb-2 w-full rounded-xl px-3 py-2.5 text-left text-sm font-semibold",
                      onDocs
                        ? "bg-brand-soft text-brand"
                        : "text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]",
                    ].join(" ")}
                    onClick={() => {
                      setDrawerOpen(false);
                      softPush("/app/docs");
                    }}
                  >
                    资料
                  </button>
                  <button
                    type="button"
                    className={[
                      "mb-2 w-full rounded-xl px-3 py-2.5 text-left text-sm font-semibold",
                      onStudy
                        ? "bg-brand-soft text-brand"
                        : "text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]",
                    ].join(" ")}
                    onClick={() => {
                      setDrawerOpen(false);
                      softPush("/app/study");
                    }}
                  >
                    学习计划
                  </button>
                  <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="搜索空间"
                    className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
                  />
                </div>

                <div className="relative min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-4">
                  <div className="flex w-full items-center gap-0.5">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
                      onClick={() =>
                        setSpaceToast((v) =>
                          v === "private" ? null : "private",
                        )
                      }
                    >
                      <span>我的空间</span>
                    </button>
                    <CreateSpaceModal
                      defaultVisibility="private"
                      hideDefaultTrigger
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-lg font-medium text-[var(--brand-ink)] transition-colors hover:bg-[var(--surface-muted)]"
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded-xl px-2 py-2.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                      onClick={() =>
                        setSpaceToast((v) =>
                          v === "private" ? null : "private",
                        )
                      }
                    >
                      {spaceToast === "private" ? "收起" : "展开"}
                    </button>
                  </div>

                  <div className="mt-1 flex w-full items-center gap-0.5">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-[var(--brand-ink)] hover:bg-[var(--surface-muted)]"
                      onClick={() =>
                        setSpaceToast((v) =>
                          v === "public" ? null : "public",
                        )
                      }
                    >
                      <span>公共空间</span>
                    </button>
                    <CreateSpaceModal
                      defaultVisibility="public"
                      hideDefaultTrigger
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-lg font-medium text-[var(--brand-ink)] transition-colors hover:bg-[var(--surface-muted)]"
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded-xl px-2 py-2.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                      onClick={() =>
                        setSpaceToast((v) =>
                          v === "public" ? null : "public",
                        )
                      }
                    >
                      {spaceToast === "public" ? "收起" : "展开"}
                    </button>
                  </div>

                  {spaceToast ? (
                    <div className="absolute left-2 right-2 top-24 z-20 max-h-[50vh] overflow-y-auto rounded-2xl border border-[var(--border-muted)] bg-white p-2 shadow-xl">
                      <p className="px-2 pb-1 text-[11px] text-[var(--text-muted)]">
                        {spaceToast === "private" ? "我的空间" : "公共空间"} ·
                        点名称进入
                      </p>
                      <SpaceKindNav
                        spaces={spaceToast === "private" ? priv : pubs}
                        storagePrefix={
                          spaceToast === "private"
                            ? "sharetodo-nav-priv-kind"
                            : "sharetodo-nav-pubs-kind"
                        }
                        emptyText="暂无空间"
                        flat
                        hideSubtitle
                        actionsPlacement="stacked"
                        onQuickCreate={(id) => {
                          setQuickSpaceId(id);
                          setDrawerOpen(false);
                          setSpaceToast(null);
                        }}
                        onNavigate={() => {
                          setDrawerOpen(false);
                          setSpaceToast(null);
                        }}
                      />
                    </div>
                  ) : null}

                  <div className="mt-4 flex items-center gap-2 border-t border-[var(--border-muted)] pt-3">
                    <CreateSpaceModal iconOnly />
                    <div className="min-w-0 flex-1">
                      <JoinSpaceModal compact />
                    </div>
                  </div>

                  <div className="mt-3 min-h-[12rem] border-t border-[var(--border-muted)] pt-2">
                    <SidebarUnscheduled spaces={spaces} />
                  </div>

                  {/* 原 ··· 能力：作用于当前选中空间 */}
                  <div className="mt-3 space-y-1.5 border-t border-[var(--border-muted)] pt-3">
                    <p className="px-1 text-[11px] text-[var(--text-muted)]">
                      空间操作
                      {focusSpace ? ` · ${focusSpace.name}` : " · 请先选空间"}
                    </p>
                    <button
                      type="button"
                      disabled={!focusSpace}
                      className={drawerActionBtn}
                      onClick={() => {
                        if (!focusSpace) return;
                        setDrawerOpen(false);
                        setAiSpace(focusSpace);
                      }}
                    >
                      AI 助手
                    </button>
                    <button
                      type="button"
                      disabled={!focusSpace}
                      className={drawerActionBtn}
                      onClick={() => {
                        if (!focusSpace) return;
                        setDrawerOpen(false);
                        setQuickSpaceId(focusSpace.id);
                      }}
                    >
                      快速创建
                    </button>
                    {canManageAny ? (
                      <>
                        <button
                          type="button"
                          className={drawerActionBtn}
                          onClick={() => {
                            setDrawerOpen(false);
                            setPanelMode("invites");
                          }}
                        >
                          邀请成员
                        </button>
                        {focusSpace?.role === "owner" ? (
                          <button
                            type="button"
                            className={`${drawerActionBtn} text-red-600`}
                            onClick={() => {
                              if (!focusSpace) return;
                              if (
                                !confirm(
                                  `确定删除空间「${focusSpace.name}」？成员与待办将一并删除，且不可恢复。`,
                                )
                              ) {
                                return;
                              }
                              void (async () => {
                                const supabase = createClient();
                                const { error } = await supabase
                                  .from("spaces")
                                  .delete()
                                  .eq("id", focusSpace.id);
                                if (error) {
                                  alert(error.message || "删除失败");
                                  return;
                                }
                                setDrawerOpen(false);
                                softPush("/app?view=calendar&range=week", {
                                  refresh: true,
                                });
                              })();
                            }}
                          >
                            删除空间
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={drawerActionBtn}
                          onClick={() => {
                            setDrawerOpen(false);
                            setPanelMode("members");
                          }}
                        >
                          成员管理
                        </button>
                      </>
                    ) : null}
                    {(focusSpace?.role === "owner" ||
                      focusSpace?.role === "admin") && (
                      <button
                        type="button"
                        className={drawerActionBtn}
                        onClick={() => {
                          if (!focusSpace) return;
                          setDrawerOpen(false);
                          softPush(
                            `/app/spaces/${focusSpace.id}?panel=settings`,
                          );
                        }}
                      >
                        空间设置
                      </button>
                    )}
                    {focusSpace && focusSpace.role !== "owner" ? (
                      <button
                        type="button"
                        className={drawerActionBtn}
                        onClick={() => {
                          setDrawerOpen(false);
                          softPush(
                            `/app/spaces/${focusSpace.id}?panel=leave`,
                          );
                        }}
                      >
                        离开空间
                      </button>
                    ) : null}
                  </div>
                </div>
      </Modal>

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

function drawerViewBtn(active: boolean) {
  return [
    "flex flex-1 flex-col items-center gap-1.5 rounded-xl px-2 py-2.5 text-[11px] font-medium transition-colors",
    active
      ? "bg-zinc-900 text-white"
      : "text-[var(--text-muted)] hover:bg-[var(--surface-muted)]",
  ].join(" ");
}

const drawerActionBtn =
  "w-full rounded-xl border border-[#2f5f8f]/40 bg-white px-3 py-2.5 text-left text-sm font-medium text-[#2f5f8f] transition-colors hover:bg-[#e8f0f7] disabled:cursor-not-allowed disabled:opacity-40";

/** 三线+圆点，打开左侧抽屉 */
function MobileMenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="5" cy="7" r="1.5" fill="currentColor" />
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="5" cy="17" r="1.5" fill="currentColor" />
      <path
        d="M9 7h11M9 12h11M9 17h11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DrawerIconBoards() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-orange-100 text-orange-600">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
        <rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
        <rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
        <rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    </span>
  );
}

function DrawerIconList() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-sky-100 text-sky-600">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M8 7h12M8 12h12M8 17h12"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <circle cx="4.5" cy="7" r="1.2" fill="currentColor" />
        <circle cx="4.5" cy="12" r="1.2" fill="currentColor" />
        <circle cx="4.5" cy="17" r="1.2" fill="currentColor" />
      </svg>
    </span>
  );
}

function DrawerIconCalendar() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-violet-100 text-violet-600">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect
          x="3"
          y="5"
          width="18"
          height="16"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <path d="M3 10h18" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M8 3v4M16 3v4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

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

