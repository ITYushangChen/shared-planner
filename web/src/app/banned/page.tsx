"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function BannedPage() {
  const [reason, setReason] = useState<string>("");
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase
          .from("profiles")
          .select("banned_reason")
          .eq("id", user.id)
          .maybeSingle();
        setReason((data as { banned_reason?: string | null } | null)?.banned_reason ?? "");
      }
    })();
  }, []);

  async function logout() {
    setLoggingOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-2xl border border-red-200 bg-red-50 px-6 py-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-red-700">账号已被封禁</h1>
        <p className="mt-3 text-sm leading-relaxed text-red-600">
          你的账号已被管理员封禁，暂时无法使用本应用。如有疑问，请联系管理员核实。
        </p>
        {reason ? (
          <p className="mt-4 rounded-lg bg-white px-3 py-2 text-left text-xs text-zinc-600">
            封禁原因：{reason}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={logout}
        disabled={loggingOut}
        className="mt-6 w-full rounded-xl border border-[#2f5f8f]/55 px-4 py-2 text-center text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7] disabled:opacity-50"
      >
        {loggingOut ? "退出中…" : "退出登录"}
      </button>

      <Link
        href="/login"
        className="mt-3 block text-center text-xs text-zinc-400 hover:text-zinc-600"
      >
        返回登录页
      </Link>
    </main>
  );
}
