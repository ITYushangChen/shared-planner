-- =============================================================================
-- 资料板块（第一版）：Markdown 文档 + 附件
-- 配套接口：/docs（POST 创建 / GET 列出空间文档）
--           /docs/:id（GET 详情 / PATCH 更新 / DELETE 删除）
--           /docs/:id/attachments（附件元数据）
-- 配套前端：/app/docs 资料页
-- 设计说明（P0）：正文全量存 docs.content（Markdown 文本），附件走 storage
--           library 桶直传，元数据落在 attachments 表；
--           表格 / 看板为第二、三版，暂不建表。
-- 纯增量，可安全重复执行。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) 文档表：Markdown 正文全量落库，标题 + 内容 + 创建人
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.docs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  creator_id    UUID NOT NULL REFERENCES public.profiles(id),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',          -- Markdown 正文
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docs_space ON public.docs(space_id);
CREATE INDEX IF NOT EXISTS idx_docs_creator ON public.docs(creator_id);

COMMENT ON TABLE public.docs IS
  '资料板块文档：Markdown 正文全量存表，P0 不做向量检索';

-- ---------------------------------------------------------------------------
-- 2) 附件表：文件直传 storage library 桶，这里只存元数据
--    doc_id 可空：NULL = 独立空间附件；非空 = 挂在某篇文档下
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  doc_id        UUID REFERENCES public.docs(id) ON DELETE CASCADE,
  uploader_id   UUID NOT NULL REFERENCES public.profiles(id),
  bucket_path   TEXT NOT NULL,                  -- storage 对象路径（第一段 = 上传人 uid）
  name          TEXT NOT NULL,                  -- 原始文件名
  size          BIGINT NOT NULL DEFAULT 0,      -- 字节数
  mime_type     TEXT,                           -- MIME 类型
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_space ON public.attachments(space_id);
CREATE INDEX IF NOT EXISTS idx_attachments_doc ON public.attachments(doc_id);

COMMENT ON TABLE public.attachments IS
  '资料板块附件元数据；文件本体在 storage library 桶，doc_id 为空时是空间级独立附件';

-- ---------------------------------------------------------------------------
-- 3) updated_at 自动更新触发器（照抄既有 set_updated_at）
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_docs_updated ON public.docs;
CREATE TRIGGER trg_docs_updated
  BEFORE UPDATE ON public.docs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) RLS：口径照抄 knowledge_sources 模式
--     SELECT：空间成员可见；INSERT：空间成员 + 本人；
--     UPDATE/DELETE：本人 或 空间 owner/admin
-- ---------------------------------------------------------------------------
ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "docs_select_member" ON public.docs;
CREATE POLICY "docs_select_member"
  ON public.docs FOR SELECT TO authenticated
  USING (public.is_space_member(space_id));

DROP POLICY IF EXISTS "docs_insert_member" ON public.docs;
CREATE POLICY "docs_insert_member"
  ON public.docs FOR INSERT TO authenticated
  WITH CHECK (public.is_space_member(space_id) AND creator_id = auth.uid());

DROP POLICY IF EXISTS "docs_update_own" ON public.docs;
CREATE POLICY "docs_update_own"
  ON public.docs FOR UPDATE TO authenticated
  USING (creator_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

DROP POLICY IF EXISTS "docs_delete_own" ON public.docs;
CREATE POLICY "docs_delete_own"
  ON public.docs FOR DELETE TO authenticated
  USING (creator_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

DROP POLICY IF EXISTS "attachments_select_member" ON public.attachments;
CREATE POLICY "attachments_select_member"
  ON public.attachments FOR SELECT TO authenticated
  USING (public.is_space_member(space_id));

DROP POLICY IF EXISTS "attachments_insert_member" ON public.attachments;
CREATE POLICY "attachments_insert_member"
  ON public.attachments FOR INSERT TO authenticated
  WITH CHECK (public.is_space_member(space_id) AND uploader_id = auth.uid());

DROP POLICY IF EXISTS "attachments_update_own" ON public.attachments;
CREATE POLICY "attachments_update_own"
  ON public.attachments FOR UPDATE TO authenticated
  USING (uploader_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

DROP POLICY IF EXISTS "attachments_delete_own" ON public.attachments;
CREATE POLICY "attachments_delete_own"
  ON public.attachments FOR DELETE TO authenticated
  USING (uploader_id = auth.uid() OR public.is_space_owner_or_admin(space_id));

-- ---------------------------------------------------------------------------
-- 5) storage library 桶 + 对象策略（照抄 backgrounds 修复版，幂等）
--    公开读；仅本人可写自己目录（路径第一段 = auth.uid()）
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'library',
  'library',
  TRUE,
  52428800,
  NULL                                   -- 不限文件类型，资料库可传任意附件
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "library_public_read" ON storage.objects;
CREATE POLICY "library_public_read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'library');

DROP POLICY IF EXISTS "library_insert_own" ON storage.objects;
CREATE POLICY "library_insert_own"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'library'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "library_update_own" ON storage.objects;
CREATE POLICY "library_update_own"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'library'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'library'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "library_delete_own" ON storage.objects;
CREATE POLICY "library_delete_own"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'library'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
