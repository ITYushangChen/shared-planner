-- =============================================================================
-- 功能 B（试水期 → 自动校准每日学习量）前置数据兜底：
--   todos.completed_at 自动写入触发器
--
-- 背景：todos.completed_at 字段早在初始化迁移里就存在，前端三条完成路径
--   （todo-editor / todo-list-panel / compact-todo-card）也都写了它，
--   但后端「飞书卡片按钮回调」只改 status 不写 completed_at。
--   而「每日学习量自动校准」要靠 completed_at 判定某块是哪一天完成的，
--   所以加一个 BEFORE 触发器兜底：任何路径只要 status 变成 done 就自动补时间戳，
--   撤销（status 离开 done）就清空。这样前端 / 飞书 / 未来任何写路径口径一致。
--
-- 纯增量，可安全重复执行。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.todos_touch_completed_at()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' THEN
    -- 保留调用方已传的时间戳；没传（如飞书回调）则用服务器时间兜底
    NEW.completed_at := COALESCE(NEW.completed_at, NOW());
  ELSE
    -- 撤销完成 / 回到待办或进行中：清空完成时间
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_todos_touch_completed_at ON public.todos;
CREATE TRIGGER trg_todos_touch_completed_at
  BEFORE INSERT OR UPDATE ON public.todos
  FOR EACH ROW EXECUTE FUNCTION public.todos_touch_completed_at();

COMMENT ON FUNCTION public.todos_touch_completed_at IS
  '完成待办（status=done）自动补 completed_at，撤销则清空；供「每日学习量自动校准」按天统计完成量';
