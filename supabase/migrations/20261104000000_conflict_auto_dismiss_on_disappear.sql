-- 问题①：冲突「自然消失」后自动清理
--   现状：对方把冲突任务改期/删除，重叠真的不存在了，但没人去点「解决/忽略」，
--   导致 conflict_resolutions 的 pending 单子与 type='conflict' 通知僵尸残留
--   （前端标红随真实重叠消失而自动消失，库里这两条记录却还在）。
--   修复：在 todos 的 UPDATE/DELETE 上加触发器，重算受影响的 pending/escalated
--   conflict_resolutions；若 check_schedule_conflicts 已查不到重叠，则置为 dismissed
--   并删除对应的 type='conflict' 通知。同时附带一次初始化，清理已自然消失的历史僵尸。

CREATE OR REPLACE FUNCTION public.auto_dismiss_disappeared_conflicts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed_todo_id UUID;
  r public.conflict_resolutions%ROWTYPE;
BEGIN
  -- 仅当排期(start_at/end_at)或状态(status)真正变化时才处理；改标题等不动
  IF TG_OP <> 'DELETE' THEN
    IF NEW.start_at IS NOT DISTINCT FROM OLD.start_at
       AND NEW.end_at IS NOT DISTINCT FROM OLD.end_at
       AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NULL;
    END IF;
    changed_todo_id := NEW.id;
  ELSE
    changed_todo_id := OLD.id;
  END IF;

  -- 受影响 resolution：自身 todo 被改动，或作为别人的冲突方(conflicting_todo_ids)被改动
  FOR r IN
    SELECT DISTINCT cr.*
    FROM public.conflict_resolutions cr
    WHERE cr.status IN ('pending', 'escalated')
      AND (cr.todo_id = changed_todo_id
           OR cr.conflicting_todo_ids @> ARRAY[changed_todo_id])
  LOOP
    -- 重算：resolution 自身 todo 是否仍与任意其他日程重叠
    PERFORM 1
    FROM public.todos t
    WHERE t.id = r.todo_id
      AND t.status <> 'done'
      AND t.start_at IS NOT NULL
      AND t.end_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.check_schedule_conflicts(t.space_id, r.user_id, t.start_at, t.end_at, t.id) c
      );

    IF NOT FOUND THEN
      UPDATE public.conflict_resolutions
      SET status = 'dismissed',
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE id = r.id;

      DELETE FROM public.notifications
      WHERE type = 'conflict'
        AND payload->>'resolution_id' = r.id::text;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_resolve_disappeared_conflicts ON public.todos;
CREATE TRIGGER trg_resolve_disappeared_conflicts
  AFTER UPDATE OR DELETE ON public.todos
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_dismiss_disappeared_conflicts();

GRANT EXECUTE ON FUNCTION public.auto_dismiss_disappeared_conflicts() TO authenticated;

-- 初始化：对现有 pending/escalated 冲突做一次重算，清理已自然消失的历史僵尸
DO $$
DECLARE
  r public.conflict_resolutions%ROWTYPE;
BEGIN
  FOR r IN
    SELECT cr.*
    FROM public.conflict_resolutions cr
    WHERE cr.status IN ('pending', 'escalated')
  LOOP
    PERFORM 1
    FROM public.todos t
    WHERE t.id = r.todo_id
      AND t.status <> 'done'
      AND t.start_at IS NOT NULL
      AND t.end_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.check_schedule_conflicts(t.space_id, r.user_id, t.start_at, t.end_at, t.id) c
      );

    IF NOT FOUND THEN
      UPDATE public.conflict_resolutions
      SET status = 'dismissed',
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE id = r.id;

      DELETE FROM public.notifications
      WHERE type = 'conflict'
        AND payload->>'resolution_id' = r.id::text;
    END IF;
  END LOOP;
END $$;
