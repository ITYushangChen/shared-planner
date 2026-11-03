"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { SpaceMemberOption, SpaceNavItem, TodoRow } from "@/lib/todos";
import type { InviteRow } from "@/lib/invites";
import { prefetchSpaceCalendarTodos } from "@/lib/space-data-cache";
import {
  getCachedSpaceBootstrap,
  loadSpaceBootstrap,
  type SpaceBootstrap,
} from "@/lib/space-bootstrap";
import { BackToAppButton } from "../../back-to-app-button";
import { SpaceWorkspace } from "../../space-workspace";
import { DeferredTodosRealtime } from "../../deferred-todos-realtime";
import { SpaceManageChrome } from "./space-manage-chrome";

/**
 * 空间详情页（客户端组件 + 一次取全量）。
 *
 * 性能要点（2026-11-02 实测优化）：
 * 1. 首屏数据由 get_space_bootstrap 一次 RPC 返回（空间/角色/时区/成员/邀请），
 *    不再是「验登录 → 成员关系 → 时区 → 成员列表」四轮串行跨境往返。
 * 2. 待办在发起 bootstrap 的同时并行预取（prefetchSpaceCalendarTodos），
 *    SpaceWorkspace 挂载时直接命中 inflight/缓存，不再多等一轮。
 * 3. 结果按 space_id 缓存：切回看过的空间立即渲染，后台静默刷新。
 * 4. 切换期间保留旧内容 + 顶部细进度条，不再整块显示「加载空间…」。
 */
export default function SpaceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [data, setData] = useState<SpaceBootstrap | null>(null);
  const [denied, setDenied] = useState(false);
  const [pending, setPending] = useState(true);
  const hasContentRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const cached = getCachedSpaceBootstrap(id);
    if (cached) {
      hasContentRef.current = true;
      setData(cached);
      setDenied(false);
      setPending(false);
    } else {
      // 无缓存：有旧空间内容就继续显示旧内容，只挂顶部进度条，避免白屏
      setPending(true);
    }

    // 待办与 bootstrap 并行拉，省掉一轮串行往返
    prefetchSpaceCalendarTodos(id);

    void loadSpaceBootstrap(id, {
      onData: (next) => {
        if (cancelled) return;
        hasContentRef.current = true;
        setData(next);
        setDenied(false);
        setPending(false);
      },
    }).then((result) => {
      if (cancelled) return;
      if (!result) {
        // 有旧内容时不误判为「被移出空间」（网络抖动也会返回空）
        if (!hasContentRef.current) setDenied(true);
        setPending(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return null;

  if (denied) {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 p-4 md:p-6">
        <h1 className="text-2xl font-semibold text-zinc-900">无法访问该空间</h1>
        <p className="text-sm text-zinc-600">
          你可能已被移出该空间，或邀请尚未生效。请返回总览或使用邀请码重新加入。
        </p>
        <div className="flex flex-wrap gap-3">
          <BackToAppButton />
          <a
            href="/app/join"
            className="inline-flex rounded-xl border border-[#2f5f8f]/55 bg-white px-4 py-2 text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7]"
          >
            输入邀请码加入
          </a>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--text-muted)]">
        加载空间…
      </main>
    );
  }

  const { space, role, userId, timezone } = data;
  const canManage = role === "owner" || role === "admin";
  const canAssign = canManage;
  const isOwner = role === "owner" || space.owner_id === userId;

  const spaceNav: SpaceNavItem = {
    id: space.id,
    name: space.name,
    kind: space.kind,
    role,
    visibility: space.visibility ?? "private",
  };

  return (
    <main className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      {pending ? (
        <div
          className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-[#e8f0f7]"
          aria-hidden="true"
        >
          <span className="sp-progress-bar block h-full w-1/3 bg-[#2f5f8f]" />
        </div>
      ) : null}

      <DeferredTodosRealtime spaceId={space.id} />

      <Suspense fallback={null}>
        <SpaceManageChrome
          space={space}
          spaceNav={spaceNav}
          memberOptions={data.memberOptions as SpaceMemberOption[]}
          memberRows={data.memberRows}
          invites={data.invites as InviteRow[]}
          canManage={canManage}
          canAssign={canAssign}
          isOwner={isOwner}
          currentUserId={userId}
          currentRole={role}
          timezone={timezone ?? undefined}
        >
          <SpaceWorkspace
            space={spaceNav}
            todos={[] as TodoRow[]}
            allTodos={[] as TodoRow[]}
            scheduled={[] as TodoRow[]}
            unscheduled={[] as TodoRow[]}
            completed={[] as TodoRow[]}
            members={[] as SpaceMemberOption[]}
            canAssign={canAssign}
            currentUserId={userId}
            deferTodos
            deferMembers
            listTitle={
              canManage
                ? "待办列表（筛选 / 排序）"
                : "我的待办（仅显示指派给我的）"
            }
          />
        </SpaceManageChrome>
      </Suspense>
    </main>
  );
}
