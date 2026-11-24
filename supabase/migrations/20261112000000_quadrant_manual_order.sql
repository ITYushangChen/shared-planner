-- 四象限自由拖拽：新增「手动象限归属」与「列内顺序」
-- manual_quadrant 非空时，覆盖按 时间/重要性 自动计算的象限（让用户随意摆放）。
-- quadrant_order 用于象限内手动排序（升序）。

alter table public.todos add column if not exists manual_quadrant text;
alter table public.todos add column if not exists quadrant_order integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'todos_manual_quadrant_check'
  ) then
    alter table public.todos add constraint todos_manual_quadrant_check
      check (
        manual_quadrant is null
        or manual_quadrant in ('urgent_important','urgent_normal','important','normal')
      );
  end if;
end $$;

comment on column public.todos.manual_quadrant is
  '四象限手动归属；非空时覆盖按时间/重要性自动计算的象限';
comment on column public.todos.quadrant_order is
  '象限内排序（升序），用于手动拖拽排序，null 表示未手动排序';

create index if not exists idx_todos_manual_quadrant
  on public.todos (manual_quadrant)
  where manual_quadrant is not null;
