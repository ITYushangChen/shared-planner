-- =============================================================================
-- 知识板块：知识源 + 问题拆解方案
-- 配套接口：/ai/knowledge/sources（POST 添加 / GET 列出知识源）
--           /ai/knowledge/decompose（DeepSeek 拆解问题 → 生成可执行方案）
--           /ai/knowledge/confirm（确认方案 → 状态转 confirmed）
-- 配套前端：/app/knowledge 知识板块页
-- 设计说明（P0）：不引入向量库，知识正文全量存表 + 简单关键词检索；
--           拆解产物 plan_json 存为 JSONB，供「先方案后执行」闭环使用。
-- 纯增量，可安全重复执行。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) 知识源表：网页 / 飞书文档两种来源，正文抓取后全量落库
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id),
  type        TEXT NOT NULL CHECK (type IN ('web', 'feishu')),  -- web | feishu
  title       TEXT NOT NULL,
  url         TEXT,                          -- 网页源为原始 URL；飞书源为文档 token/链接
  content     TEXT,                          -- 抓取到的正文纯文本
  status      TEXT NOT NULL DEFAULT 'ready'
              CHECK (status IN ('ready', 'fetching', 'failed')), -- ready | fetching | failed
  error       TEXT,                          -- 抓取失败原因
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_space ON public.knowledge_sources(space_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_type ON public.knowledge_sources(type);

COMMENT ON TABLE public.knowledge_sources IS
  '知识源（网页/飞书文档），正文全量存表；P0 用简单关键词检索，P1 再上 embedding 向量检索';

-- ---------------------------------------------------------------------------
-- 2) 问题拆解方案表：先方案后执行，pending → confirmed → applied
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id),
  question    TEXT NOT NULL,                  -- 用户原始问题
  summary     TEXT,                           -- AI 生成的一句话方案概述
  plan_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- plan_json 结构：{ "summary": string, "steps": [{ "no", "title", "action", "depends_on", "expected" }] }
  sources     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- sources 结构：[{ "id", "title" }] 本次拆解用到的知识源
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'confirmed', 'applied', 'failed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_plans_space ON public.knowledge_plans(space_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_plans_status ON public.knowledge_plans(status);

COMMENT ON TABLE public.knowledge_plans IS
  '问题拆解方案（先方案后执行）：pending(待确认) → confirmed(已确认) → applied(已执行)';

-- ---------------------------------------------------------------------------
-- 3) RLS：口径照抄既有模式
--     SELECT：空间成员可见；INSERT：空间成员 + 本人；
--     UPDATE/DELETE：本人 或 空间 owner/admin
-- ---------------------------------------------------------------------------
ALTER TABLE public.knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "knowledge_sources_select_member"
  ON public.knowledge_sources FOR SELECT TO authenticated
  USING (public.is_space_member(space_id));

CREATE POLICY "knowledge_sources_insert_member"
  ON public.knowledge_sources FOR INSERT TO authenticated
  WITH CHECK (public.is_space_member(space_id) AND user_id = auth.uid());

CREATE POLICY "knowledge_sources_update_own"
  ON public.knowledge_sources FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

CREATE POLICY "knowledge_sources_delete_own"
  ON public.knowledge_sources FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

CREATE POLICY "knowledge_plans_select_member"
  ON public.knowledge_plans FOR SELECT TO authenticated
  USING (public.is_space_member(space_id));

CREATE POLICY "knowledge_plans_insert_member"
  ON public.knowledge_plans FOR INSERT TO authenticated
  WITH CHECK (public.is_space_member(space_id) AND user_id = auth.uid());

CREATE POLICY "knowledge_plans_update_own"
  ON public.knowledge_plans FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

CREATE POLICY "knowledge_plans_delete_own"
  ON public.knowledge_plans FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_space_owner_or_admin(space_id));
