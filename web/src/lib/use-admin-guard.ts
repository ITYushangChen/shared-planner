"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type AdminGuard = "loading" | "logged-out" | "forbidden" | "admin";

/**
 * 统一管理员鉴权：检查当前登录用户是否为应用管理员（profiles.is_admin）。
 * 所有管理员工具面板共用，避免每个面板重复 getUser + is_app_admin 的逻辑。
 *
 * 降级策略：权限函数不可用时（如服务端尚未重载 schema 缓存）一律判为 forbidden，
 * 避免 await 抛异常导致面板永久卡在「加载中」（历史上真实踩过的坑）。
 */
export function useAdminGuard(): { guard: AdminGuard; loading: boolean } {
  const [guard, setGuard] = useState<AdminGuard>("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) setGuard("logged-out");
          return;
        }
        const { data, error } = await supabase.rpc("is_app_admin");
        if (cancelled) return;
        if (error) {
          console.error("is_app_admin 校验失败：", error.message);
          setGuard("forbidden");
          return;
        }
        setGuard(data ? "admin" : "forbidden");
      } catch {
        if (!cancelled) setGuard("forbidden");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { guard, loading: guard === "loading" };
}
