/**
 * 按指定时区算「某一天」的本地日期与 UTC 起止。
 *
 * 旧实现（先拼本地 wall time，再用 toLocaleString("UTC") / toLocaleString(tz) 相减）
 * 会把区间整体偏移一个时区差：服务器时区与目标时区相同时（Asia/Shanghai），
 * 「今天」实际变成「昨天 16:00 → 今天 15:59」，跨日归错。
 *
 * 这里用标准做法：先按 UTC 猜当日 00:00，再用该时刻的真实偏移校正；
 * 再校正一次以覆盖 DST 切换日。
 */

const OFFSET_FMT = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timezone: string): Intl.DateTimeFormat {
  let f = OFFSET_FMT.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    OFFSET_FMT.set(timezone, f);
  }
  return f;
}

/** 目标时区在某一时刻相对 UTC 的偏移（毫秒；东八区 = +28800000） */
export function tzOffsetMs(instantMs: number, timezone: string): number {
  const parts = offsetFormatter(timezone).formatToParts(new Date(instantMs));
  const pick = (type: string) => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  const asUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    pick("hour"),
    pick("minute"),
    pick("second"),
  );
  if (!Number.isFinite(asUtc)) return 0;
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

export function dayBounds(timezone: string, date = new Date()) {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  const [y, m, d] = localDate.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const first = guess - tzOffsetMs(guess, timezone);
  const start = first - (tzOffsetMs(first, timezone) - tzOffsetMs(guess, timezone));
  const end = start + 24 * 3600 * 1000 - 1;

  return {
    localDate,
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
  };
}
