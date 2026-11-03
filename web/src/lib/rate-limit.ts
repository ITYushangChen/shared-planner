/**
 * 进程内滑动窗口限流。
 *
 * 适用于单实例部署（当前 pm2 单进程 + Caddy）。若将来多实例横向扩容，
 * 需要换成 Redis / Upstash 之类的共享存储，否则每个实例各自计数会放宽阈值。
 *
 * 只用于低频、高风险的写接口（登录、注册、改密、找回码校验）。
 */
type Bucket = { hits: number[]; lastSweep: number };

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 5000;

function sweep(now: number, windowMs: number) {
  // 顺带清理过期 key，避免 Map 无界增长
  if (buckets.size > MAX_KEYS) {
    for (const [k, v] of buckets) {
      if (now - v.lastSweep > windowMs) buckets.delete(k);
    }
  }
}

export type RateResult = { ok: boolean; retryAfterSec: number };

/**
 * @param key   限流维度，例如 `login:${ip}:${email}`
 * @param limit 窗口内允许的次数
 * @param windowMs 窗口长度（毫秒）
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateResult {
  const now = Date.now();
  sweep(now, windowMs);

  const bucket = buckets.get(key) ?? { hits: [], lastSweep: now };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= limit) {
    bucket.lastSweep = now;
    buckets.set(key, bucket);
    const oldest = bucket.hits[0] ?? now;
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }

  bucket.hits.push(now);
  bucket.lastSweep = now;
  buckets.set(key, bucket);
  return { ok: true, retryAfterSec: 0 };
}

/** 从请求里取客户端 IP（经 Caddy 反代时看 x-forwarded-for 第一跳） */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    "unknown"
  );
}
