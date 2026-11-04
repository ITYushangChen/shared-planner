-- =============================================================================
-- 协作安全与体验修复（2026-11-03）
--   问题1：todos 查询可见性仅前端过滤 → 收紧 RLS（纵深防御）
--   问题2：成员加入后不补检冲突/不补发指派通知 → accept_invitation 后补跑
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 问题1：todos 查询策略收紧
--   原策略 is_space_member(space_id) 让任何成员可读取空间内【全部】待办。
--   改为：owner/admin 看全部；普通成员仅看「自己创建」或「被指派给自己」的待办。
-- ---------------------------------------------------------------------------
-- 可见性判定：owner/admin 看全部；普通成员仅看"自己创建 / 被指派给自己"的待办。
-- SECURITY DEFINER：以所有者身份读取，绕过 RLS，避免与关联表策略形成递归。
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

-- ---------------------------------------------------------------------------
-- 问题2：新成员加入后补检冲突 + 补发「被指派」通知
--   真实场景：A 先指派带排期待办给尚未加入的 B，B 之后才用邀请码加入。
--   原 notify_todo_assignment 只在指派/改期那一刻跑一次，且要求被指派人已是成员，
--   导致 B 加入后永远收不到冲突提醒。此处加入成功后补跑。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_conflicts_for_new_member(
  p_space_id UUID,
  p_user_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.todos%ROWTYPE;
  conflicts UUID[];
  existing_id UUID;
  res_id UUID;
  already_notified BOOLEAN;
BEGIN
  FOR t IN
    SELECT t2.*
    FROM public.todos t2
    JOIN public.todo_assignees ta ON ta.todo_id = t2.id
    WHERE t2.space_id = p_space_id
      AND ta.user_id = p_user_id
      AND t2.status <> 'done'
  LOOP
    -- 补发"被指派"通知（去重：该 todo 已有 assigned 通知则跳过，避免重复加入刷屏）
    SELECT EXISTS (
      SELECT 1 FROM public.notifications
      WHERE user_id = p_user_id
        AND space_id = p_space_id
        AND type = 'assigned'
        AND payload->>'todo_id' = t.id::text
    ) INTO already_notified;

    IF NOT already_notified THEN
      INSERT INTO public.notifications (user_id, space_id, type, title, body, payload)
      VALUES (
        p_user_id, p_space_id, 'assigned',
        '你被指派了新任务', t.title,
        jsonb_build_object('todo_id', t.id, 'by', t.creator_id)
      );
    END IF;

    -- 有排期则补检该成员冲突
    IF t.start_at IS NOT NULL AND t.end_at IS NOT NULL THEN
      SELECT ARRAY_AGG(c.id) INTO conflicts
      FROM public.check_schedule_conflicts(
        p_space_id, p_user_id, t.start_at, t.end_at, t.id
      ) c;

      IF conflicts IS NOT NULL AND cardinality(conflicts) > 0 THEN
        SELECT cr.id INTO existing_id
        FROM public.conflict_resolutions cr
        WHERE cr.todo_id = t.id
          AND cr.user_id = p_user_id
          AND cr.status IN ('pending', 'escalated')
        ORDER BY cr.created_at DESC
        LIMIT 1;

        IF existing_id IS NOT NULL THEN
          UPDATE public.conflict_resolutions
          SET conflicting_todo_ids = conflicts, updated_at = NOW()
          WHERE id = existing_id;
          res_id := existing_id;
        ELSE
          INSERT INTO public.conflict_resolutions (
            space_id, todo_id, user_id, creator_id, conflicting_todo_ids, status
          )
          VALUES (p_space_id, t.id, p_user_id, t.creator_id, conflicts, 'pending')
          RETURNING id INTO res_id;
        END IF;

        INSERT INTO public.notifications (user_id, space_id, type, title, body, payload)
        VALUES (
          p_user_id, p_space_id, 'conflict',
          '日程冲突提醒',
          '任务「' || t.title || '」与你现有日程重叠（含其他空间）',
          jsonb_build_object(
            'todo_id', t.id,
            'resolution_id', res_id,
            'conflicting_todo_ids', to_jsonb(conflicts)
          )
        );
      END IF;
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_conflicts_for_new_member(UUID, UUID) TO authenticated;

-- 重建 accept_invitation：在成员插入成功后补跑冲突/指派补发
CREATE OR REPLACE FUNCTION public.accept_invitation(p_code TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv public.space_invitations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO inv
  FROM public.space_invitations
  WHERE code = p_code AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid invite';
  END IF;

  IF inv.expires_at IS NOT NULL AND inv.expires_at < NOW() THEN
    UPDATE public.space_invitations SET status = 'expired' WHERE id = inv.id;
    RAISE EXCEPTION 'invite expired';
  END IF;

  IF inv.max_uses IS NOT NULL AND inv.used_count >= inv.max_uses THEN
    RAISE EXCEPTION 'invite exhausted';
  END IF;

  INSERT INTO public.space_members (space_id, user_id, role)
  VALUES (inv.space_id, auth.uid(), 'member')
  ON CONFLICT (space_id, user_id) DO NOTHING;

  UPDATE public.space_invitations
  SET used_count = used_count + 1,
      status = CASE
        WHEN max_uses IS NOT NULL AND used_count + 1 >= max_uses
          THEN 'accepted'::public.invite_status
        ELSE status
      END
  WHERE id = inv.id;

  -- 新成员加入后，补检其被指派待办的冲突并补发指派通知。
  -- 用异常保护：补检失败不应阻断加入本身。
  BEGIN
    PERFORM public.notify_conflicts_for_new_member(inv.space_id, auth.uid());
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN inv.space_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_invitation(TEXT) TO authenticated;
