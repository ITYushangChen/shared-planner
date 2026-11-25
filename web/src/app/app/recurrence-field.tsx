"use client";

import { RECUR_OPTIONS } from "@/lib/todos";

const CUSTOM_VALUE = "__custom__";
const pad = (n: number) => String(n).padStart(2, "0");

/** 本地日期 YYYY-MM-DD → RRULE UNTIL（当天 23:59:59 的 UTC 绝对时刻，避免时区歧义） */
function dateToUntil(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T23:59:59`);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** RRULE UNTIL → 本地日期 YYYY-MM-DD（存的是本地当天末尾的 UTC 时刻，读回还原成本地日期） */
function untilToDate(rrule: string): string {
  const m = /UNTIL=(\d{8})T(\d{6})Z/i.exec(rrule);
  if (!m) {
    const d = /UNTIL=(\d{8})/i.exec(rrule)?.[1];
    return d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : "";
  }
  const [y, mo, da] = [m[1].slice(0, 4), m[1].slice(4, 6), m[1].slice(6, 8)];
  const [h, mi, s] = [m[2].slice(0, 2), m[2].slice(2, 4), m[2].slice(4, 6)];
  const d = new Date(Date.UTC(+y, +mo - 1, +da, +h, +mi, +s));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** rrule 是否是未列入预设的自定义重复（含自定义间隔或截至日期） */
export function isCustomRecurrence(value: string): boolean {
  if (!value) return false;
  if (RECUR_OPTIONS.some((o) => o.value === value)) return false;
  return /^FREQ=(DAILY|WEEKLY)(;INTERVAL=\d+)?(;UNTIL=[0-9TZ]+)?$/i.test(value);
}

function parseCustom(value: string): {
  unit: "DAILY" | "WEEKLY";
  interval: number;
  until: string;
} {
  return {
    unit: /FREQ=WEEKLY/i.test(value) ? "WEEKLY" : "DAILY",
    interval: Math.max(1, parseInt(/INTERVAL=(\d+)/i.exec(value)?.[1] || "1", 10) || 1),
    until: untilToDate(value),
  };
}

function buildRrule(
  unit: "DAILY" | "WEEKLY",
  interval: number,
  untilDate: string,
): string {
  const parts = [`FREQ=${unit}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  const until = dateToUntil(untilDate);
  if (until) parts.push(`UNTIL=${until}`);
  return parts.join(";");
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** label 右侧的辅助文字，默认「可选」 */
  hint?: string;
};

/**
 * 重复规则选择器。
 * 预设下拉 + 「自定义…」面板：先选单位（天/周）与间隔 N（N=1 即每天/每周），
 * 再可选截至日期。产出标准 RRULE（含 UNTIL 时为 UTC 绝对时刻），
 * 与 DB 触发器 rrule_next_occurrence 和 rruleLabel 兼容。
 */
export function RecurrenceField({ value, onChange, hint = "可选" }: Props) {
  const custom = isCustomRecurrence(value);
  const parsed = parseCustom(value);

  function choose(v: string) {
    // 自定义模式默认带 INTERVAL=1：与「每天」等价但不在预设列表里，
    // isCustomRecurrence 才能识别为自定义、展开面板（选完再按 N 与截至日重建）
    onChange(v === CUSTOM_VALUE ? "FREQ=DAILY;INTERVAL=1" : v);
  }

  function update(unit: "DAILY" | "WEEKLY", interval: number, until: string) {
    onChange(buildRrule(unit, interval, until));
  }

  function setInterval(n: number) {
    const safe = Math.min(365, Math.max(1, Math.floor(n) || 1));
    update(parsed.unit, safe, parsed.until);
  }

  function setUntil(d: string) {
    update(parsed.unit, parsed.interval, d);
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between text-xs text-zinc-600">
        <span>重复</span>
        <span className="text-[10px] text-zinc-400">{hint}</span>
      </label>
      <select
        className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none"
        value={custom ? CUSTOM_VALUE : value}
        onChange={(e) => choose(e.target.value)}
      >
        {RECUR_OPTIONS.map((o) => (
          <option key={o.value || "none"} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value={CUSTOM_VALUE}>自定义…</option>
      </select>
      {custom ? (
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600">每</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              aria-label="重复间隔数"
              className="w-16 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm outline-none"
              value={parsed.interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
            <select
              aria-label="重复间隔单位"
              className="flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm outline-none"
              value={parsed.unit}
              onChange={(e) =>
                update(e.target.value as "DAILY" | "WEEKLY", parsed.interval, parsed.until)
              }
            >
              <option value="DAILY">天（填 1 即每天）</option>
              <option value="WEEKLY">周（填 1 即每周）</option>
            </select>
          </div>
          <label className="text-[11px] text-zinc-500">
            截至日期（可选，留空一直重复）
            <input
              type="date"
              aria-label="重复截至日期"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
              value={parsed.until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
