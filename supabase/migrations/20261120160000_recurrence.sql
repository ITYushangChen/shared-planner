-- 20261120160000_recurrence.sql
-- 重复任务 / 习惯打卡（recurrence）
--
-- 思路（最小可用版，成本可控）：
--   1) todos 加两列：rrule（RFC 5545 规则串）、series_id（同系列实例归组）。
--   2) 完成一条「带 rrule 的待办」时，由 DB 触发器自动生成「下一次」实例，
--      已完成的那条本身即打卡历史（不用额外打卡表）。
--
-- 为什么用 DB 触发器而不是前端逻辑：
--   完成入口有三个（todo-editor 的 onSave/onComplete、compact-todo-card 的
--   toggleDone），在前端三处都写「生成下一实例」极易漏、极易重复造。
--   触发器（AFTER UPDATE OF status）统一兜底，任何入口标记完成都会触发。
--
-- 关键点：
--   - 触发器函数 SECURITY DEFINER（owner=postgres）：trigger 上下文里 auth.uid()
--     为 NULL，若走 RLS 会被 can_insert_todo 拒绝；用 SECURITY DEFINER 显式绕过，
--     并从 OLD 行继承 creator_id / space_id，保证下一实例归属不变。
--   - 幂等：同 series_id 已存在「未完成」实例时不再生成，防止反复完成/反复打卡
--     造成重复任务。
--   - rrule 解析只支持 FREQ=DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL（前端下拉只
--     产出这三种），未知 FREQ 安全兜底不生成。BYDAY 等高级规则暂不在此实现。
--
-- 改完需 docker restart supabase-rest（虽然本迁移不新增 RPC，但统一照旧惯例）。

-- ---------------------------------------------------------------------------
-- 1) 加列
-- ---------------------------------------------------------------------------
alter table public.todos
  add column if not exists rrule text,
  add column if not exists series_id uuid;

create index if not exists idx_todos_series on public.todos (series_id);

comment on column public.todos.rrule is
  '重复规则（RFC 5545 RRULE 子集），如 FREQ=DAILY / FREQ=WEEKLY / FREQ=MONTHLY；NULL=不重复';
comment on column public.todos.series_id is
  '同系列循环实例归组 id；首条完成时取自身 id，后续实例继承';

-- ---------------------------------------------------------------------------
-- 2) 纯计算函数：从 rrule 推下一个发生时间（只读、不碰表，无权限面）
-- ---------------------------------------------------------------------------
create or replace function public.rrule_next_occurrence(p_rrule text, p_from timestamptz)
  returns timestamptz
  language plpgsql
  stable
as $fn$
declare
  freq  text;
  inter integer := 1;
  m     text[];
begin
  if p_rrule is null or p_from is null then
    return null;
  end if;

  freq := upper(coalesce(substring(p_rrule from 'FREQ=([A-Za-z]+)'), ''));
  m := regexp_match(p_rrule, 'INTERVAL=([0-9]+)', 'i');
  if m is not null and m[1] is not null then
    inter := greatest(1, m[1]::integer);
  end if;

  if freq = 'DAILY' then
    return p_from + make_interval(days => inter);
  elsif freq = 'WEEKLY' then
    return p_from + make_interval(days => inter * 7);
  elsif freq = 'MONTHLY' then
    return p_from + make_interval(months => inter);
  elsif freq = 'YEARLY' then
    return p_from + make_interval(years => inter);
  else
    return null; -- 未知 FREQ：安全兜底，不生成下一实例
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3) 触发器函数：完成带 rrule 的待办时，生成下一次实例 + 复制指派人
-- ---------------------------------------------------------------------------
create or replace function public.todos_generate_next_recurrence()
  returns trigger
  language plpgsql
  security definer
  set search_path to public
as $fn$
declare
  sid          uuid;
  base_start   timestamptz;
  next_start   timestamptz;
  next_end     timestamptz;
  next_due     timestamptz;
  existing_open boolean;
  new_id       uuid;
begin
  -- 只在「未完成 → 完成」且带 rrule 时生成
  if new.status <> 'done' then
    return new;
  end if;
  if old.status = 'done' then
    return new; -- 已完成再保存，不重复触发
  end if;
  if old.rrule is null or btrim(old.rrule) = '' then
    return new;
  end if;

  sid := coalesce(old.series_id, old.id);

  -- 幂等：同系列已存在「未完成」实例则不重复生成（防反复打卡/重复完成）
  select exists (
    select 1
    from public.todos t
    where t.series_id = sid
      and t.status <> 'done'
      and t.id <> new.id
  ) into existing_open;
  if existing_open then
    return new;
  end if;

  if old.start_at is null and old.due_at is null then
    -- 未排期且无截止的循环：下一实例也保持未排期（仅重新生成一条待办）
    next_start := null;
    next_end   := null;
  else
    base_start := coalesce(old.start_at, old.due_at);
    next_start := public.rrule_next_occurrence(old.rrule, base_start);
    if next_start is null then
      return new; -- rrule 无法解析：安全兜底，不生成
    end if;

    if old.is_all_day then
      next_end := next_start + interval '1 day';
    elsif old.start_at is not null and old.end_at is not null then
      next_end := next_start + (old.end_at - old.start_at);
    elsif old.duration_minutes is not null and old.duration_minutes > 0 then
      next_end := next_start + make_interval(mins => old.duration_minutes);
    else
      next_end := next_start + interval '1 hour';
    end if;
  end if;

  -- 截止时间按同一规则顺延
  next_due := case
    when old.due_at is not null
      then public.rrule_next_occurrence(old.rrule, old.due_at)
    else null
  end;

  insert into public.todos (
    space_id, creator_id, title, description, priority, status,
    start_at, end_at, is_all_day, due_at, duration_minutes,
    source, rrule, series_id, sort_score
  ) values (
    old.space_id, old.creator_id, old.title, old.description, old.priority, 'todo',
    next_start, next_end, old.is_all_day, next_due, old.duration_minutes,
    old.source, old.rrule, sid, null
  )
  returning id into new_id;

  -- 复制指派人（保持团队可见性/冲突检测口径一致）
  insert into public.todo_assignees (todo_id, user_id)
  select new_id, a.user_id
  from public.todo_assignees a
  where a.todo_id = old.id;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4) 挂触发器
-- ---------------------------------------------------------------------------
drop trigger if exists trg_todos_next_recurrence on public.todos;
create trigger trg_todos_next_recurrence
  after update of status on public.todos
  for each row
  execute function public.todos_generate_next_recurrence();
