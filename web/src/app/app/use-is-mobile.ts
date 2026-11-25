"use client";

import { useEffect, useState } from "react";

/**
 * 手机端判断（≤767px），口径与 overview-workspace 等既有代码一致。
 * SSR 首帧为 false（桌面），挂载后按真实视口切换；弹窗内容打开时 effect 早已跑完，无闪烁。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isMobile;
}
