-- 根因修复：冲突「解决/忽略/打回」时，删除原始冲突通知不应限定 user_id
--
-- 现象：同一个 conflict_resolution 可能涉及多个冲突方（如 creator 与 assignee 不同人），
-- notify_todo_assignment 会给每个相关用户各写一条 type='conflict' 通知，但 payload.resolution_id
-- 都指向同一个 resolution。而 resolve_conflict_self / dismiss_conflict_resolution / escalate_conflict_resolution
-- 删除通知时带 `user_id = r.user_id`（或 OR creator/escalated_to）限制，导致只删掉其中一条，
-- 其余成为「冲突已关闭但通知仍在」的孤儿（之前 dc185621 漏删 2 条即此）。
--
-- 修复：所有删通知都改为按 resolution_id 无条件删除该 resolution 的全部 conflict 通知。
-- 注意顺序：escalate 先删旧通知再写「打回」新通知，改为无条件删后仍只保留新写的那一条，行为正确。

-- ① 被指派人「自己解决」：解决后删除该 resolution 的全部原始冲突通知
CREATE OR REPLACE FUNCTION public.resolve_conflict_self(p_resolution_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.conflict_resolutions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO r FROM public.conflict_resolutions WHERE id = p_resolution_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution not found';
  END IF;
  IF r.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'only assignee can self-resolve';
  END IF;
  IF r.status <> 'pending' AND r.status <> 'escalated' THEN
    RAISE EXCEPTION 'resolution already closed';
  END IF;

  UPDATE public.conflict_resolutions
  SET status = 'self_resolved',
      resolved_at = NOW(),
      updated_at = NOW()
  WHERE id = p_resolution_id;

  -- 清理：该 resolution 的全部「日程冲突提醒」通知（不限 user_id）
  DELETE FROM public.notifications
  WHERE type = 'conflict'
    AND payload->>'resolution_id' = r.id::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_conflict_self(UUID) TO authenticated;

-- ② 创建人/管理员关闭：关闭时删除该 resolution 的全部冲突通知
CREATE OR REPLACE FUNCTION public.dismiss_conflict_resolution(p_resolution_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.conflict_resolutions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO r FROM public.conflict_resolutions WHERE id = p_resolution_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution not found';
  END IF;
  IF r.creator_id <> auth.uid() AND r.user_id <> auth.uid() AND r.escalated_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  UPDATE public.conflict_resolutions
  SET status = 'dismissed',
      resolved_at = NOW(),
      updated_at = NOW()
  WHERE id = p_resolution_id;

  -- 清理：该 resolution 的全部冲突通知（不限 user_id）
  DELETE FROM public.notifications
  WHERE type = 'conflict'
    AND payload->>'resolution_id' = r.id::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dismiss_conflict_resolution(UUID) TO authenticated;

-- ③ 升级/打回：先删除该 resolution 的全部原始冲突通知，再给目标写「打回」通知
CREATE OR REPLACE FUNCTION public.escalate_conflict_resolution(
  p_resolution_id UUID,
  p_note TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.conflict_resolutions%ROWTYPE;
  ttitle TEXT;
  v_note TEXT := trim(COALESCE(p_note, ''));
  v_target UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF v_note = '' THEN
    RAISE EXCEPTION 'reason required';
  END IF;

  SELECT * INTO r FROM public.conflict_resolutions WHERE id = p_resolution_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution not found';
  END IF;
  IF r.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'only assignee can escalate';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'resolution not pending';
  END IF;

  -- 目标：创建人≠被指派人 → 创建人；否则升级给空间 owner/admin
  IF r.creator_id <> r.user_id THEN
    v_target := r.creator_id;
  ELSE
    SELECT sm.user_id INTO v_target
    FROM public.space_members sm
    WHERE sm.space_id = r.space_id
      AND sm.role IN ('owner', 'admin')
      AND sm.user_id <> auth.uid()
    ORDER BY (sm.role = 'owner') DESC
    LIMIT 1;

    IF v_target IS NULL THEN
      RAISE EXCEPTION 'no owner or admin to escalate to';
    END IF;
  END IF;

  SELECT title INTO ttitle FROM public.todos WHERE id = r.todo_id;

  UPDATE public.conflict_resolutions
  SET status = 'escalated',
      note = v_note,
      escalated_to = v_target,
      updated_at = NOW()
  WHERE id = p_resolution_id;

  -- 清理：该 resolution 的全部原始「日程冲突提醒」通知（不限 user_id）
  DELETE FROM public.notifications
  WHERE type = 'conflict'
    AND payload->>'resolution_id' = r.id::text;

  INSERT INTO public.notifications (user_id, space_id, type, title, body, payload)
  VALUES (
    v_target,
    r.space_id,
    'conflict',
    '冲突已打回给你',
    '被指派人无法自行消化「' || COALESCE(ttitle, '任务') || '」的冲突。原因：' || v_note,
    jsonb_build_object(
      'resolution_id', r.id,
      'todo_id', r.todo_id,
      'from_user', auth.uid(),
      'note', v_note,
      'conflicting_todo_ids', to_jsonb(r.conflicting_todo_ids)
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.escalate_conflict_resolution(UUID, TEXT) TO authenticated;

-- ④ 保险：清理任何「resolution 已关闭但冲突通知残留」的历史孤儿
DO $$
DECLARE
  d_count INT;
BEGIN
  DELETE FROM public.notifications n
  WHERE n.type = 'conflict'
    AND n.payload->>'resolution_id' IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.conflict_resolutions cr
      WHERE cr.id::text = n.payload->>'resolution_id'
        AND cr.status IN ('pending', 'escalated')
    );
  GET DIAGNOSTICS d_count = ROW_COUNT;
  RAISE NOTICE 'cleaned % orphan conflict notifications', d_count;
END $$;
