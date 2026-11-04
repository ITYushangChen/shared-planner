-- =============================================================================
-- 修复 20261103000000 引入的 RLS 策略递归
--   原因：todos_select_member 引用 todo_assignees，而 assignees_select_member
--         （及 comments_select_member）又引用 todos，互相触发对方 RLS → 无限递归，
--         导致普通成员的待办查询直接报错（被 PostgREST 静默吞掉，返回空）。
--   修复：引入 SECURITY DEFINER 帮助函数 can_see_todo() 统一判定"某待办对某用户可见"，
--         其以函数所有者身份读取（绕过 RLS），从而打破递归。
--         三张表的 SELECT 策略统一收敛到"可见性一致"，彻底关闭跨成员窥探。
-- =============================================================================

-- 可见性判定：owner/admin 看全部；普通成员仅看"自己创建 / 被指派给自己"的待办。
-- SECURITY DEFINER：以所有者身份读取 todos/todo_assignees/space_members，绕过 RLS，避免递归。
CREATE OR REPLACE FUNCTION public.can_see_todo(p_todo_id UUID, p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.can_see_todo(UUID, UUID) TO authenticated;

-- todos：统一用 can_see_todo（DEFINER，无递归）
DROP POLICY IF EXISTS "todos_select_member" ON public.todos;
CREATE POLICY "todos_select_member"
  ON public.todos FOR SELECT TO authenticated
  USING (public.can_see_todo(id, auth.uid()));

-- 指派：自己那行永远可见；其余仅当该待办对自己可见时才可见
DROP POLICY IF EXISTS "assignees_select_member" ON public.todo_assignees;
CREATE POLICY "assignees_select_member"
  ON public.todo_assignees FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.can_see_todo(todo_id, auth.uid())
  );

-- 评论：作者那行永远可见；其余仅当该待办对自己可见时才可见
DROP POLICY IF EXISTS "comments_select_member" ON public.todo_comments;
CREATE POLICY "comments_select_member"
  ON public.todo_comments FOR SELECT TO authenticated
  USING (
    author_id = auth.uid()
    OR public.can_see_todo(todo_id, auth.uid())
  );
