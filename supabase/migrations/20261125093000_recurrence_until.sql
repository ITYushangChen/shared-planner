-- 20261125093000_recurrence_until.sql
-- 重复任务：支持「截至日期」（RRULE UNTIL）
--
-- 背景：原 rrule_next_occurrence 只解析 FREQ + INTERVAL，忽略 UNTIL，
--       带截至日期的重复会无限生成下去。
-- 方案：只 create or replace 这一个纯计算函数（stable、不碰表、无权限面），
--       解析 UNTIL=YYYYMMDDTHHMMSSZ（UTC 绝对时刻），若下一次落点超过截至时刻
--       返回 NULL → 触发器见到 NULL 即不再生成下一次实例。
-- 纯增量、可重复执行；触发器主体与其余函数不动。

create or replace function public.rrule_next_occurrence(p_rrule text, p_from timestamptz)
  returns timestamptz
  language plpgsql
  stable
as $fn$
declare
  freq     text;
  inter    integer := 1;
  m        text[];
  until_at timestamptz := null;
  next_at  timestamptz;
begin
  if p_rrule is null or p_from is null then
    return null;
  end if;

  freq := upper(coalesce(substring(p_rrule from 'FREQ=([A-Za-z]+)'), ''));
  m := regexp_match(p_rrule, 'INTERVAL=([0-9]+)', 'i');
  if m is not null and m[1] is not null then
    inter := greatest(1, m[1]::integer);
  end if;

  -- UNTIL=YYYYMMDDTHHMMSSZ → UTC 绝对时刻；非法值忽略（安全兜底，不提前截断）
  -- 用 (字符串::timestamp) at time zone 'UTC'：先把数字当 UTC 壁钟时间读成 timestamp，
  -- 再明确标注 UTC 转成 timestamptz。不能对 to_timestamp() 的结果用 at time zone，
  -- 那会双重按 session TZ 解释，导致截至日期偏一个时区。
  m := regexp_match(p_rrule, 'UNTIL=([0-9]{8})T([0-9]{6})Z', 'i');
  if m is not null and m[1] is not null and m[2] is not null then
    begin
      until_at :=
        to_timestamp(m[1] || m[2], 'YYYYMMDDHH24MISS')::timestamp at time zone 'UTC';
    exception when others then
      until_at := null;
    end;
  end if;

  if freq = 'DAILY' then
    next_at := p_from + make_interval(days => inter);
  elsif freq = 'WEEKLY' then
    next_at := p_from + make_interval(days => inter * 7);
  elsif freq = 'MONTHLY' then
    next_at := p_from + make_interval(months => inter);
  elsif freq = 'YEARLY' then
    next_at := p_from + make_interval(years => inter);
  else
    return null; -- 未知 FREQ：安全兜底，不生成下一实例
  end if;

  -- 下一次落点晚于截至时刻 → 停止生成
  if until_at is not null and next_at > until_at then
    return null;
  end if;

  return next_at;
end;
$fn$;

comment on function public.rrule_next_occurrence(text, timestamptz) is
  '从 RRULE 推下一次发生时间；支持 FREQ=DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL + UNTIL(UTC 绝对时刻)；超过 UNTIL 返回 NULL';
