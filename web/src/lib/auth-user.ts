import type {
  AuthChangeEvent,
  Session,
  User,
} from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

/**
 * B 方案：客户端登录态共享缓存。
 *
 * 背景：`supabase.auth.getUser()` 是**每次都发网络请求**去问服务器
 * （GET /auth/v1/user），不是读本地。全站有 30 处调用，光是进一次空间页
 * 就会并发触发 3 次（page / 通知铃 / 侧栏未排期），跨境 RTT 一叠加，
 * 光「验自己是自己」就要 300~400ms，还互相排队。
 *
 * 这里改成：`getSession()`（读本地 cookie/存储，**零网络**）取一次，
 * 模块级缓存复用；登录态变化时由 onAuthStateChange 更新。
 *
 * 安全性：本地 session 由服务端签名，伪造不了；真正的数据权限由
 * RLS 在数据库侧把关，不依赖前端这次 getUser。需要「强制服务端校验」
 * 的场景（如改密）仍显式调用 `supabase.auth.getUser()`。
 */

let cachedUser: User | null | undefined;
let inflight: Promise<User | null> | null = null;
let subscribed = false;

function ensureSubscribed() {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  createClient().auth.onAuthStateChange(
    (event: AuthChangeEvent, session: Session | null) => {
      if (session?.user) {
        cachedUser = session.user;
      } else if (event === "SIGNED_OUT") {
        cachedUser = null;
      } else {
        cachedUser = undefined;
      }
    },
  );
}

/** 同步读已知登录态；还不知道时返回 undefined */
export function peekAuthUser(): User | null | undefined {
  return cachedUser;
}

/** 取当前登录用户：首次读本地 session（零网络），之后走缓存 */
export function getAuthUser(): Promise<User | null> {
  ensureSubscribed();
  if (cachedUser !== undefined) return Promise.resolve(cachedUser);
  const running = inflight;
  if (running) return running;

  const pending: Promise<User | null> = createClient()
    .auth.getSession()
    .then(({ data }: { data: { session: Session | null } }) => {
      cachedUser = data.session?.user ?? null;
      return cachedUser;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });

  inflight = pending;
  return pending;
}

/** 登录 / 登出后重置缓存 */
export function resetAuthUser(user?: User | null) {
  cachedUser = user;
  inflight = null;
}
