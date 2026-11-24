-- 20261106010000_admin_audit_log.sql
-- 管理操作审计日志：记录管理员的关键写操作（重置密码、封禁、删号、转让空间等）。
-- 写入只经 SECURITY DEFINER 函数 log_admin_action()，绕过 RLS；
-- 读取由管理端点用 service_role 完成。本表为纯增量，可安全重复执行。

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     UUID NOT NULL REFERENCES auth.users(id),
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    UUID,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor ON public.admin_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON public.admin_audit_log(created_at DESC);

COMMENT ON TABLE public.admin_audit_log IS
  '管理操作审计日志；由 log_admin_action() 写入，管理端点经 service_role 读取';

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- 用户可看自己发起的记录（无害）；全量审计读取走 service_role，不受此策略限制
CREATE POLICY "audit_select_own"
  ON public.admin_audit_log FOR SELECT TO authenticated
  USING (actor_id = auth.uid());

-- 禁用直接 INSERT（必须经过函数），故不给 INSERT 策略
GRANT SELECT ON public.admin_audit_log TO authenticated;
GRANT SELECT, INSERT ON public.admin_audit_log TO service_role;

-- 写入函数：SECURITY DEFINER 让函数以定义者身份插入，绕过 RLS 与 INSERT 策略限制。
-- 注意：此处不使用 pgcrypto，search_path 只需 public。
CREATE OR REPLACE FUNCTION public.log_admin_action(
  p_actor_id    UUID,
  p_action      TEXT,
  p_target_type TEXT DEFAULT NULL,
  p_target_id   UUID DEFAULT NULL,
  p_detail     JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, detail)
  VALUES (p_actor_id, p_action, p_target_type, p_target_id, p_detail)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_admin_action(UUID, TEXT, TEXT, UUID, JSONB)
  TO authenticated, service_role;
