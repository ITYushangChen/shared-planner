"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { REALTIME_ENABLED } from "@/lib/realtime-enabled";

/** realtime 不可用时的轮询兜底间隔（成员变动频率低，间隔可放宽） */
const MEMBERS_POLL_INTERVAL_MS = 15000;
/** 宽限期后【始终】启动轮询兜底（与订阅解耦，订阅抛错也不影响） */
const MEMBERS_FALLBACK_GRACE_MS = 3000;

/**
 * 订阅若干空间的 space_members 变更（成员加入 / 退出 / 被移出 / 空间删除级联）。
 *
 * 与 useSpaceNavRealtime 的区别：后者只订阅「当前用户自己」的 membership 行
 * （filter: user_id=eq.<当前用户>），因此收不到「别人加入我所在空间」的事件；
 * 本 hook 按 space_id 过滤，任一成员变动都会触发 onChange，用于刷新「指派成员
 * 列表 / 成员面板」，避免「新人加入后指派下拉还只剩自己」这类陈旧缓存。
 *
 * 受 RLS 约束：当前用户仅能收到其所属空间的变更（is_space_member 策略）。
 *
 * 兜底：若 realtime 服务不可用（如自托管 slim 版未部署 realtime 容器，订阅永远
 * 到不了 SUBSCRIBED），则降级为定时轮询 onChange，实现「不刷新页面即同步成员」。
 *
 * @param spaceIds 需要监听成员变更的空间 id 列表
 * @param onChange 任一成员变动时的回调（通常触发一次成员列表重拉）
 */
export function useWatchSpaceMembers(
  spaceIds: string[],
  onChange: () => void,
) {
  const key = spaceIds.join(",");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!REALTIME_ENABLED) return;
    if (!key) return;
    const ids = key.split(",");
    let cancelled = false;
    const supabase = createClient();
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const fire = () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      onChangeRef.current();
    };

    let ch: ReturnType<typeof supabase.channel> | null = null;
    // 1) 先无条件排轮询兜底（与订阅解耦）：subscribe 万一抛错也不影响轮询启动
    graceTimer = setTimeout(() => {
      if (cancelled) return;
      fire(); // 立即首轮
      pollTimer = setInterval(fire, MEMBERS_POLL_INTERVAL_MS);
    }, MEMBERS_FALLBACK_GRACE_MS);

    // 2) 再尝试订阅 realtime，仅作即时补充；失败被 catch 兜住
    try {
      ch = supabase
        .channel(`watch-space-members-${key}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "space_members",
            filter: `space_id=in.(${ids.join(",")})`,
          },
          () => {
            if (cancelled) return;
            fire();
          },
        )
        .subscribe(() => {});
    } catch {
      // 订阅失败不影响轮询兜底
    }

    return () => {
      cancelled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (ch) void supabase.removeChannel(ch);
    };
  }, [key]);
}
