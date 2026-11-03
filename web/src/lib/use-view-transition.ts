"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback } from "react";

/**
 * 空间跳转：普通的 App Router 软导航（包一层 startTransition）。
 *
 * ⚠️ 为什么不用 View Transitions（2026-11-02 移除）
 * 之前这里用 document.startViewTransition 包住 router.push，并要求等两帧才 resolve：
 *
 *   doc.startViewTransition(() => {
 *     router.push(href);
 *     return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
 *   });
 *
 * 问题有两层：
 * 1. 过渡开始后浏览器会把旧页拍成静态快照并**暂停渲染**，等 callback 的 Promise resolve
 *    才开始下一帧。callback 里要等两帧 rAF，而 rAF 在「非前台 / 被节流的渲染器」
 *    （笔记本省电模式、嵌入式预览面板、后台标签）里可能只有 1fps —— 两帧就是 2 秒起，
 *    用户看到的就是「点了没反应」。
 * 2. router.push 是异步的，两帧时新路由的 RSC 往往还没回来，快照抓到的还是旧内容，
 *    动画放完才「啪」地换成新页 —— 观感是卡一下再跳，不如不淡入淡出。
 *
 * 现在改为纯客户端软导航：URL 立即变、旧内容继续显示，新内容就绪后原地替换
 * （进度条由 space page 自己渲染）。既没有冻结，也没有错位动画。
 */
export function useViewTransition() {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      startTransition(() => {
        router.push(href);
      });
    },
    [router],
  );
}
