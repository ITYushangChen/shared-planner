-- =============================================================================
-- 学习计划：书本目录 → 学习单元 → 自动排程 → 生成待办
-- 配套接口：
--   POST /ai/study/outline  目录解析（飞书文档 / 粘贴文本 / 只给书名）
--   POST /ai/study/plan     估时切单元 + 确定性装箱 → 计划预览（落库 planned）
--   POST /ai/study/apply    确认后写待办（planned → applied）
--   GET  /ai/study/plans    计划列表 + 进度
--
-- 设计原则（关键）：
--   AI 只负责「把目录切成学习单元 + 给每单元估分钟数」；
--   「这些单元铺到哪几天几点」由本地确定性算法完成。
--   这样排期可复现、可解释，改参数（每天时长变了）秒级重排，不再烧 AI 调用。
--
-- 纯增量，可安全重复执行。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) 计划头表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.study_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES public.profiles(id),
  book_title    TEXT NOT NULL,
  -- 目录来源：feishu(飞书云文档) | text(粘贴目录) | book(只给书名)
  source_type   TEXT NOT NULL DEFAULT 'text'
                CHECK (source_type IN ('feishu', 'text', 'book')),
  source_url    TEXT,
  -- 最终采用的章节数组（用户可在前端编辑后再排期）
  -- [{ "no":1, "title":"第1章 ...", "level":1, "parent_no":null, "minutes":180 }]
  outline       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 目录可信度：{ "confidence":"high|low", "needs_review":true, "note":"..." }
  outline_meta  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 排期参数：{ daily_start, daily_end, daily_minutes_cap, weekdays, start_date,
  --            deadline, unit_minutes, timezone }
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 排期结果摘要：{ total_minutes, unit_count, end_date, days_needed, deadline_fit, ... }
  summary       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned', 'applied', 'archived')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_plans_space  ON public.study_plans(space_id);
CREATE INDEX IF NOT EXISTS idx_study_plans_user   ON public.study_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_study_plans_status ON public.study_plans(status);

COMMENT ON TABLE public.study_plans IS
  '学习计划头：书本目录 + 排期参数 + 排期结果摘要；AI 只估时长，排期由本地算法装箱';

-- ---------------------------------------------------------------------------
-- 2) 学习单元表（一行 = 日历上的一个学习块）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.study_plan_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         UUID NOT NULL REFERENCES public.study_plans(id) ON DELETE CASCADE,
  space_id        UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  chapter_no      INTEGER,
  minutes         INTEGER NOT NULL CHECK (minutes > 0),
  scheduled_start TIMESTAMPTZ,
  scheduled_end   TIMESTAMPTZ,
  -- apply 之后回填，一个学习单元对应一条待办
  todo_id         UUID REFERENCES public.todos(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'done', 'skipped')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_items_plan  ON public.study_plan_items(plan_id);
CREATE INDEX IF NOT EXISTS idx_study_items_space ON public.study_plan_items(space_id);
CREATE INDEX IF NOT EXISTS idx_study_items_todo  ON public.study_plan_items(todo_id);

COMMENT ON TABLE public.study_plan_items IS
  '学习单元：calendared 学习块，apply 后 todo_id 回填，可据此算进度';

-- ---------------------------------------------------------------------------
-- 3) RLS：口径与 knowledge_sources 保持一致
--    SELECT：空间成员可见；INSERT：空间成员 + 本人；
--    UPDATE/DELETE：本人 或 空间 owner/admin
-- ---------------------------------------------------------------------------
ALTER TABLE public.study_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_plan_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "study_plans_select_member"      ON public.study_plans;
DROP POLICY IF EXISTS "study_plans_insert_member"      ON public.study_plans;
DROP POLICY IF EXISTS "study_plans_update_own"         ON public.study_plans;
DROP POLICY IF EXISTS "study_plans_delete_own"         ON public.study_plans;

CREATE POLICY "study_plans_select_member"
  ON public.study_plans FOR SELECT TO authenticated
  USING (public.is_space_member(space_id));

CREATE POLICY "study_plans_insert_member"
  ON public.study_plans FOR INSERT TO authenticated
  WITH CHECK (public.is_space_member(space_id) AND user_id = auth.uid());

CREATE POLICY "study_plans_update_own"
  ON public.study_plans FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

CREATE POLICY "study_plans_delete_own"
  ON public.study_plans FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

DROP POLICY IF EXISTS "study_items_select_member" ON public.study_plan_items;
DROP POLICY IF EXISTS "study_items_insert_member" ON public.study_plan_items;
DROP POLICY IF EXISTS "study_items_update_member" ON public.study_plan_items;
DROP POLICY IF EXISTS "study_items_delete_own"    ON public.study_plan_items;

CREATE POLICY "study_items_select_member"
  ON public.study_plan_items FOR SELECT TO authenticated
  USING (public.is_space_member(space_id));

CREATE POLICY "study_items_insert_member"
  ON public.study_plan_items FOR INSERT TO authenticated
  WITH CHECK (public.is_space_member(space_id));

CREATE POLICY "study_items_update_member"
  ON public.study_plan_items FOR UPDATE TO authenticated
  USING (public.is_space_member(space_id) OR public.is_space_owner_or_admin(space_id));

CREATE POLICY "study_items_delete_own"
  ON public.study_plan_items FOR DELETE TO authenticated
  USING (public.is_space_member(space_id) OR public.is_space_owner_or_admin(space_id));

-- ---------------------------------------------------------------------------
-- 4) 进度视图：按 todo 完成情况算每个计划的完成单元数（前端列表直接用）
-- ---------------------------------------------------------------------------
-- security_invoker=true：视图按调用者权限执行，否则默认以视图 owner 身份
-- 运行会绕过 RLS，把所有人计划统计暴露给任意登录用户。
CREATE OR REPLACE VIEW public.study_plan_progress
WITH (security_invoker = true) AS
SELECT
  i.plan_id,
  COUNT(*)::int                                        AS total_units,
  COUNT(*) FILTER (WHERE i.todo_id IS NOT NULL
                     AND t.status = 'done')::int       AS done_units,
  COALESCE(SUM(i.minutes), 0)::int                     AS total_minutes,
  COALESCE(SUM(i.minutes) FILTER (WHERE t.status = 'done'), 0)::int AS done_minutes
FROM public.study_plan_items i
LEFT JOIN public.todos t ON t.id = i.todo_id
GROUP BY i.plan_id;

COMMENT ON VIEW public.study_plan_progress IS
  '学习计划进度：单元总数/已完成数、总分钟/已完成分钟（按 todo 完成状态）';
