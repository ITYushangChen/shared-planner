-- 20261113000000_fix_rls_tighten_read_and_owner_write.sql
-- 修复线上 RLS 漂移 + owner 写权限缺陷（2026-11-13）
--
-- 漂移事实（线上实测，与 20261103010000 提交的收紧意图不符）：
--   public.can_see_todo 被多塞了一行 `OR public.is_space_member(t.space_id)`，
--   导致"任何空间成员可读全空间所有待办"，读隔离在 DB 层从未真正生效。
-- 写缺陷：
--   public.can_insert_todo 的 WITH CHECK 要求 p_creator_id = p_user，
--   使 owner/admin 也改不动成员创建的待办（PATCH 返回 403）。
--
-- 本迁移（CREATE OR REPLACE，固化进 git 以对齐 live）：
--   1) 读收紧：去掉 is_space_member；成员仅可见 自己创建 / 被指派 / owner-admin 可见全部。
--      （前端 canViewerSeeTodo 上一轮已同步收紧，现在前后端口径一致。）
--   2) 写放开：owner/admin 可改空间内任意待办；成员建待办仍需 creator=本人（防冒名）。
--
-- 仅改函数体，policy（todos_access FOR ALL, USING=can_access_todo,
--       WITH CHECK=can_insert_todo）不变。改后需 docker restart supabase-rest。

CREATE OR REPLACE FUNCTION public.can_see_todo(p_todo_id uuid, p_user uuid)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
 AS $function$
   SELECT EXISTS (
     SELECT 1 FROM public.todos t
     WHERE t.id = p_todo_id
       AND (
         public.is_space_owner_or_admin(t.space_id)
         OR t.creator_id = p_user
         OR EXISTS (
           SELECT 1 FROM public.todo_assignees a
           WHERE a.todo_id = t.id AND a.user_id = p_user
         )
       )
   );
 $function$
;

CREATE OR REPLACE FUNCTION public.can_insert_todo(p_space_id uuid, p_creator_id uuid, p_user uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
 AS $function$
   SELECT ( public.is_space_member(p_space_id) OR public.is_space_owner_or_admin(p_space_id) )
     AND ( p_creator_id = p_user OR public.is_space_owner_or_admin(p_space_id) );
 $function$
;
