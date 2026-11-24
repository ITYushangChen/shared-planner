"use client";

import { useEffect } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { isTodosRealtimeRefreshSuppressed } from "@/lib/todos-realtime-gate";
import { REALTIME_ENABLED } from "@/lib/realtime-enabled";

/** 轻量同步信号：默认不整页 refresh，避免拖拽后闪屏 */
export const TODOS_REALTIME_CHANGED = "sharetodo:todos-realtime-changed";
/** 远程删除：携带被删 todo 的 id，供列表精准移除（绕过重拉缓存） */
export const TODOS_REALTIME_DELETED = "sharetodo:todos-realtime-deleted";
export type TodoRealtimeDeletedDetail = { todoId: string };
/** 单条待办 INSERT/UPDATE：携带改动行 id，监听器只拉该行做增量 merge */
export type TodoRealtimeRowDetail = { todoId: string };

/** 首屏稳定后再订阅 */
const SUBSCRIBE_DELAY_MS = 1500;
/**
 * Realtime 兜底：若服务不可用（如自托管 slim 版未部署 realtime 容器），
 * 订阅永远到不了 SUBSCRIBED，则降级为定时轮询，复用同一刷新信号，
 * 实现「不刷新页面也能看到他人变更」。
 */
const FALLBACK_GRACE_MS = 3000;
const POLL_INTERVAL_MS = 5000;

/**
 * 订阅待办变更。
 * 不再 router.refresh()——整页 RSC 重拉是拖任务数秒后闪屏的主因。
 * 需要同步的 UI 可监听 TODOS_REALTIME_CHANGED。
 */
export function useTodosRealtime(spaceId?: string) {
  const supabase = createClient();

  useEffect(() => {
    if (!REALTIME_ENABLED) return;

    // token 续期：Realtime WebSocket 建立后不会随 access_token 刷新自动续命。
    // 页面久挂导致 token 过期时，WS 后续推送会永久失效（只剩 5s 轮询兜底），
    // 表现为「开久了不灵、刷新页面又灵」。登录态变化（含 TOKEN_REFRESHED）
    // 时把最新 token 喂给 realtime 长连接即可续命。
    const { data: authSub } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        if (session?.access_token) {
          // setTimeout 包裹，避免回调内同步调用 supabase 触发递归告警
          setTimeout(() => {
            try {
              supabase.realtime.setAuth(session.access_token);
            } catch {
              /* noop */
            }
          }, 0);
        }
      },
    );

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // realtime 是否成功连上；连上后无需轮询兜底，避免 owner 大数据集每 5s 被整列表重拉
    let subscribed = false;

    const emit = () => {
      if (cancelled) return;
      if (isTodosRealtimeRefreshSuppressed()) return;
      // 不再拦截后台标签页：隐藏页面也照常 dispatch，切回来即最新，
      // 避免「切走的页面不实时、切回才动」被误判为不灵。
      window.dispatchEvent(new CustomEvent(TODOS_REALTIME_CHANGED));
    };

    const schedule = () => {
      if (isTodosRealtimeRefreshSuppressed()) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        emit();
      }, 400);
    };

    const startPolling = () => {
      if (pollTimer || cancelled) return;
      emit(); // 立即首轮，无需等满一个轮询周期
      pollTimer = setInterval(() => {
        // 复用同一信号：监听器会重拉并据此刷新（含删除行的自然消失）
        emit();
      }, POLL_INTERVAL_MS);
    };

    delayTimer = setTimeout(() => {
      if (cancelled) return;

      // 1) 先无条件排轮询兜底（与订阅解耦）：即便下面 subscribe 在 slim 版
      //    抛错，轮询也一定会启动，跨账号/跨标签页才靠定时重拉同步。
      graceTimer = setTimeout(() => {
        if (cancelled) return;
        // 仅当 realtime 未连上时降级为定时全量轮询兜底；连上了就不轮询，
        // 避免 owner 大数据集每 5s 被整列表重拉（即「加载慢」来源之一）。
        if (!subscribed) startPolling();
      }, FALLBACK_GRACE_MS);

      // 2) 再尝试订阅 realtime，仅作即时补充；失败被 catch 兜住，
      //    绝不影响上面的保底轮询（这是上一版「始终轮询却仍不更新」的根因）。
      //
      // ⚠️ 频道名必须是 `realtime:*` 前缀，否则 realtime-dev 服务端回 `unmatched
      // topic` 直接拒绝，长连接永远 SUBSCRIBED 不了 → 只能靠 5s 轮询兜底
      // （即「实时不灵、刷新才灵」的真因）。postgres_changes 只认 canonical
      // 频道 `realtime:postgres_changes`，故所有空间共用该 topic，按 space_id
      // 过滤做空间隔离；无 spaceId（首页「全部」）则不带 filter，订阅可见全部。
      try {
        channel = supabase
          .channel("realtime:postgres_changes")
          .on(
            "postgres_changes",
            spaceId
              ? {
                  event: "*",
                  schema: "public",
                  table: "todos",
                  filter: `space_id=eq.${spaceId}`,
                }
              : {
                  event: "*",
                  schema: "public",
                  table: "todos",
                },
            (payload: any) => {
              if (payload.eventType === "DELETE") {
                const todoId = (
                  payload.old_record as { id?: string } | undefined
                )?.id;
                if (todoId) {
                  window.dispatchEvent(
                    new CustomEvent(TODOS_REALTIME_DELETED, {
                      detail: { todoId } satisfies TodoRealtimeDeletedDetail,
                    }),
                  );
                }
                return;
              }
              // 增量打补丁：带出改动行 id，监听器只拉这一行 merge 进主列表，
              // 不再整列表全量重拉（owner 大数据集下整列表替换正是「加载慢」根因）。
              const todoId = (payload.new as { id?: string } | undefined)?.id;
              if (!todoId) return;
              if (isTodosRealtimeRefreshSuppressed()) return;
              window.dispatchEvent(
                new CustomEvent(TODOS_REALTIME_CHANGED, {
                  detail: { todoId } satisfies TodoRealtimeRowDetail,
                }),
              );
            },
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "todo_assignees" },
            schedule,
          )
          .subscribe((status?: string) => {
            // realtime 仅作即时补充；是否连上都不影响上面的保底轮询。
            if (status === "SUBSCRIBED") subscribed = true;
          });
      } catch {
        // 订阅失败不影响轮询兜底
      }
    }, SUBSCRIBE_DELAY_MS);

    return () => {
      cancelled = true;
      try {
        authSub.subscription.unsubscribe();
      } catch {
        /* noop */
      }
      if (delayTimer) clearTimeout(delayTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, spaceId]);
}
