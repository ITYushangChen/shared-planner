import { createClient } from "@/lib/supabase/client";

/**
 * 通知偏好。key 与 notifications.type 对齐：
 * daily_summary | assigned | conflict | invite
 * toast 是额外开关，控制右下角弹窗，不影响消息中心。
 */
export type NotificationPrefs = {
  daily_summary: boolean;
  assigned: boolean;
  conflict: boolean;
  invite: boolean;
  /** 右下角弹窗提醒 */
  toast: boolean;
};

export const NOTIFICATION_TYPE_META = [
  {
    key: "daily_summary",
    label: "每日摘要",
    desc: "每天汇总当天到期的任务与进展",
  },
  {
    key: "assigned",
    label: "任务指派",
    desc: "有人把任务指派给你，或改期了你负责的任务",
  },
  {
    key: "conflict",
    label: "冲突提醒",
    desc: "检测到日程冲突，需要你确认如何处理",
  },
  {
    key: "invite",
    label: "空间邀请",
    desc: "被邀请加入空间，或邀请被接受",
  },
] as const satisfies ReadonlyArray<{
  key: keyof NotificationPrefs;
  label: string;
  desc: string;
}>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  daily_summary: true,
  assigned: true,
  conflict: true,
  invite: true,
  toast: true,
};

const PREF_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS) as Array<
  keyof NotificationPrefs
>;

/** 数据库里的 JSON 可能缺字段或被手改，全部按布尔兜底 */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  const out = { ...DEFAULT_NOTIFICATION_PREFS };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const key of PREF_KEYS) {
    const v = o[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

/** 被关闭的通知类型，用于查库时排除（如 type=not.in.(conflict,invite)） */
export function disabledNotificationTypes(prefs: NotificationPrefs): string[] {
  return NOTIFICATION_TYPE_META.filter((m) => prefs[m.key] === false).map(
    (m) => m.key,
  );
}

export function isNotificationTypeEnabled(
  prefs: NotificationPrefs,
  type: string | null | undefined,
): boolean {
  if (!type) return true;
  if (!(type in DEFAULT_NOTIFICATION_PREFS)) return true;
  return prefs[type as keyof NotificationPrefs] !== false;
}

/** 列表过滤：关掉的类型不进消息中心 */
export function filterNotifications<T extends { type: string }>(
  list: T[],
  prefs: NotificationPrefs,
): T[] {
  return list.filter((n) => isNotificationTypeEnabled(prefs, n.type));
}

// ---------------------------------------------------------------------------
// 读取：铃铛、弹窗、消息中心都要用，加一层内存缓存避免每次导航都查库
// ---------------------------------------------------------------------------

type SupabaseLike = ReturnType<typeof createClient>;

let cache: { userId: string; prefs: NotificationPrefs; at: number } | null =
  null;
const CACHE_TTL_MS = 60_000;

export async function loadNotificationPrefs(
  supabase: SupabaseLike,
  userId: string,
): Promise<NotificationPrefs> {
  if (cache && cache.userId === userId && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.prefs;
  }
  const { data } = await supabase
    .from("profiles")
    .select("notification_prefs")
    .eq("id", userId)
    .maybeSingle();
  const prefs = parseNotificationPrefs(
    (data as { notification_prefs?: unknown } | null)?.notification_prefs,
  );
  cache = { userId, prefs, at: Date.now() };
  return prefs;
}

/** 保存偏好后调用：清掉缓存，让角标/列表立刻按新偏好重算 */
export function invalidateNotificationPrefsCache() {
  cache = null;
}
