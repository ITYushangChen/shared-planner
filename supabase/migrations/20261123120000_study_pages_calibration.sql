-- =============================================================================
-- 学习计划：估时改为「可校准量」
--
-- 背景：
--   原来 AI 直接吐 minutes（学完这节要多少分钟），这个数既无法自证，
--   用户也没法校正 —— 只能整体接受或整体无视。
--   改成 AI 只吐两个可观测量：
--     pages      这一项在教材上约多少页
--     difficulty 1=概念/记忆为主  2=普通  3=证明/计算密集（必须动笔）
--   分钟数由确定性公式算出：
--     minutes = pages × min_per_page × (1:0.85 / 2:1.0 / 3:1.35)
--   误差来源收敛成用户唯一需要调的旋钮 min_per_page（我一页要几分钟）。
--
-- 配套接口：
--   PATCH /ai/study/items/:id/actual   记录某学习块真实用时
--   GET   /ai/study/calibration        用实际用时反推建议 min_per_page
--
-- 纯增量，可安全重复执行。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) 学习单元：补可校准量与真实用时
-- ---------------------------------------------------------------------------
ALTER TABLE public.study_plan_items
  ADD COLUMN IF NOT EXISTS pages          INTEGER,
  ADD COLUMN IF NOT EXISTS difficulty     INTEGER,
  ADD COLUMN IF NOT EXISTS actual_minutes INTEGER;

-- 难度只能是 1~3（没给页数的老数据保持 NULL）
ALTER TABLE public.study_plan_items
  DROP CONSTRAINT IF EXISTS study_items_difficulty_chk;
ALTER TABLE public.study_plan_items
  ADD CONSTRAINT study_items_difficulty_chk
  CHECK (difficulty IS NULL OR (difficulty >= 1 AND difficulty <= 3));

ALTER TABLE public.study_plan_items
  DROP CONSTRAINT IF EXISTS study_items_pages_chk;
ALTER TABLE public.study_plan_items
  ADD CONSTRAINT study_items_pages_chk
  CHECK (pages IS NULL OR (pages > 0 AND pages <= 2000));

ALTER TABLE public.study_plan_items
  DROP CONSTRAINT IF EXISTS study_items_actual_chk;
ALTER TABLE public.study_plan_items
  ADD CONSTRAINT study_items_actual_chk
  CHECK (actual_minutes IS NULL OR (actual_minutes > 0 AND actual_minutes <= 1440));

COMMENT ON COLUMN public.study_plan_items.pages IS
  '该学习块对应的教材页数（可校准量）；老数据可能为 NULL';
COMMENT ON COLUMN public.study_plan_items.difficulty IS
  '难度 1=概念/记忆 2=普通 3=证明/计算密集；决定每页耗时系数';
COMMENT ON COLUMN public.study_plan_items.actual_minutes IS
  '用户学完自己填的真实用时，用于反推建议 min_per_page';

-- 计划头：outline / params / summary 里的 pages、min_per_page 走 JSONB，无需迁移
COMMENT ON COLUMN public.study_plans.params IS
  '排期参数：{ daily_start, daily_end, daily_minutes_cap, weekdays, start_date,
   deadline, unit_minutes, min_per_page, timezone }';
COMMENT ON COLUMN public.study_plans.outline IS
  '最终采用的章节数组（用户可在前端编辑后再排期）
   [{ "no":1, "title":"第1章 ...", "level":1, "parent_no":null,
      "pages":42, "difficulty":3, "minutes":285 }]
   minutes 由 pages×min_per_page×难度系数 算出，不再由 AI 直接给';
