-- 修复：backgrounds 桶的 storage 策略在生产库丢失
-- 现象：storage.objects RLS 已开启，但 storage schema 下 0 条策略
--      -> 任何 upload（背景图 / 空间头像）都被 RLS 拒绝
--      -> "new row violates row-level security policy"
-- 本迁移为 20260804190000_backgrounds_storage.sql 的策略部分补齐（幂等）。

-- 公开读（桶本身 public=true，这里同时给出策略，避免依赖 public bucket 路由）
DROP POLICY IF EXISTS "backgrounds_public_read" ON storage.objects;
CREATE POLICY "backgrounds_public_read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'backgrounds');

-- 仅本人可写自己目录（路径第一段 = auth.uid()）
DROP POLICY IF EXISTS "backgrounds_insert_own" ON storage.objects;
CREATE POLICY "backgrounds_insert_own"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'backgrounds'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "backgrounds_update_own" ON storage.objects;
CREATE POLICY "backgrounds_update_own"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'backgrounds'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'backgrounds'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "backgrounds_delete_own" ON storage.objects;
CREATE POLICY "backgrounds_delete_own"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'backgrounds'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
