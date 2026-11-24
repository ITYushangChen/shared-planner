"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/error-report";

/**
 * 全局错误捕获：挂在根布局，监听 window 未捕获异常与未处理的 Promise 拒绝，
 * 上报到 /auth/report-error，落入 app_error_log。无任何可见 UI。
 */
export function ErrorReporter() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      reportError("全局未捕获异常", event.error ?? event.message, {
        source: event.filename ?? undefined,
        line: event.lineno ?? undefined,
        col: event.colno ?? undefined,
      });
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      reportError("未处理的 Promise 拒绝", event.reason ?? "Unknown rejection");
    }

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
