import { createBrowserClient } from "@supabase/ssr";

// 浏览器端复用单例：避免每次调用都新建 SupabaseClient，
// 否则 use-todos-realtime 的 useEffect 会因依赖对象变化反复清理/重建 Realtime 订阅（抖动 + 泄漏）。
let browserClient: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (!browserClient) {
    browserClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return browserClient;
}
