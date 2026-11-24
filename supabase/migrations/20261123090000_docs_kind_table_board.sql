-- =============================================================================
-- 资料板块（第二、三版）：文档类型扩展 —— 表格 / 看板
-- 版本：2026-11-23
-- -----------------------------------------------------------------------------
-- 设计说明：
--   不新建表。docs 表新增 kind 列做类型判别，正文仍然全部落 docs.content：
--     kind='doc'   → content 存 Markdown 文本（第一版行为，不变）
--     kind='table' → content 存表格 JSON  {version, columns[], rows[]}
--     kind='board' → content 存看板 JSON  {version, columns[{title,cards[]}]}
--   这样附表 attachments(doc_id) 的级联、RLS 策略、storage 路径规则全部沿用，
--   零改动、零回填风险。
-- -----------------------------------------------------------------------------
-- 兼容性：已存在的历史文档 kind 自动取默认值 'doc'，行为完全不变。
-- 幂等性：可重复执行（ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) kind 列：默认 'doc'，NOT NULL，保证老数据安全
-- ---------------------------------------------------------------------------
ALTER TABLE public.docs
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'doc';

-- ---------------------------------------------------------------------------
-- 2) 取值范围约束（Postgres 不支持 ADD CONSTRAINT IF NOT EXISTS，
--    改用 DROP ... IF EXISTS 再 ADD，保证可重复执行）
-- ---------------------------------------------------------------------------
ALTER TABLE public.docs DROP CONSTRAINT IF EXISTS docs_kind_check;
ALTER TABLE public.docs
  ADD CONSTRAINT docs_kind_check CHECK (kind IN ('doc', 'table', 'board'));

COMMENT ON COLUMN public.docs.kind IS
  '资料类型：doc=Markdown 文档 / table=表格 / board=看板；content 按类型存 Markdown 或 JSON';

-- ---------------------------------------------------------------------------
-- 3) 列表页要按类型展示徽标，给 (space_id, kind) 建索引减少排序前的扫描量
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_docs_space_kind ON public.docs(space_id, kind);

-- ---------------------------------------------------------------------------
-- 4) RLS 无需改动：kind 只是同一行上的一个字段，
--    沿用 docs 既有的 select/insert/update/delete 四条策略。
-- ---------------------------------------------------------------------------
