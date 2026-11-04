-- 20261106000000_migration_tracking_table.sql
-- 生产 Supabase 是手工 apply 的，没有官方 migration 追踪表，导致"表在、函数却是旧版"
-- 这类漏跑肉眼看不出来。建一张轻量追踪表，让 apply 脚本能"查表→没记录才应用→应用完插记录"，
-- 并提供"本地目录 vs 追踪表"的漏跑对比能力。

CREATE TABLE IF NOT EXISTS public.supabase_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT 'migration_apply_script'
);

-- 仅允许读取，避免被业务 RLS 误伤；写入由 SECURITY DEFINER 的 apply 脚本/超级用户完成
GRANT SELECT ON public.supabase_migrations TO authenticated, anon, service_role;
