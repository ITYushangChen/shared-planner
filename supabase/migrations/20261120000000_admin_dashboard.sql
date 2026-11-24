-- =============================================================================
-- 管理后台：错误日志 + 账户列表（含空间个数）
-- 配套接口：/api/report-error（写错误日志）
--           /auth/admin-accounts（列账户 + 升级/降级）
--           /auth/admin-errors（读错误日志）
--           /auth/admin-audit（读审计日志，复用既有 admin_audit_log 表）
-- 配套前端：/admin 管理后台页（账户管理 / 错误日志 / 操作记录三个 tab）
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) 应用错误日志表：记录报错信息、报错操作（来源）、级别与附加上下文
--    写入只经 SECURITY DEFINER 函数 log_app_error()，绕过 RLS；
--    读取由管理端点用 service_role 完成。纯增量，可安全重复执行。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_error_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message     TEXT NOT NULL,
  operation   TEXT,                          -- 报错操作/来源，如「加载空间」「AI 排程」「全局未捕获异常」
  level       TEXT NOT NULL DEFAULT 'error', -- error / warn / info
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb, -- 附加上下文（页面 URL、堆栈、user agent 等）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_error_log_created ON public.app_error_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_error_log_operation ON public.app_error_log(operation);

COMMENT ON TABLE public.app_error_log IS
  '应用错误日志；由 log_app_error() 写入（前端全局异常/接口报错上报），管理端点经 service_role 读取';

ALTER TABLE public.app_error_log ENABLE ROW LEVEL SECURITY;

-- 不开放任何用户直读；仅 service_role 可读（管理端点用），写入走下面的函数
GRANT SELECT, INSERT ON public.app_error_log TO service_role;

-- 写入函数：SECURITY DEFINER 以定义者身份插入，绕过 RLS。
-- 对 authenticated / anon 开放，便于前端在任意登录态下上报（限流由接口层负责）。
CREATE OR REPLACE FUNCTION public.log_app_error(
  p_message   TEXT,
  p_operation TEXT DEFAULT NULL,
  p_level     TEXT DEFAULT 'error',
  p_meta      JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO public.app_error_log (message, operation, level, meta)
  VALUES (p_message, p_operation, p_level, p_meta)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_app_error(TEXT, TEXT, TEXT, JSONB)
  TO authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 2) 账户列表（含空间个数）：返回每个账号的概要 + 其「拥有或加入」的空间去重个数。
--    SECURITY DEFINER 能读到 spaces / space_members 全量（绕过 RLS），
--    因此该函数**只授权 service_role**，绝不可下放给 authenticated。
--    需求约束：只暴露空间个数，不暴露空间名称/任务内容。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_accounts()
RETURNS TABLE (
  id            UUID,
  email         TEXT,
  display_name  TEXT,
  avatar_url    TEXT,
  is_admin      BOOLEAN,
  banned        BOOLEAN,
  banned_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ,
  space_count   INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.email,
    p.display_name,
    p.avatar_url,
    p.is_admin,
    p.banned,
    p.banned_at,
    p.created_at,
    (SELECT count(*)::int FROM (
       SELECT s.id AS space_id FROM public.spaces s WHERE s.owner_id = p.id
       UNION
       SELECT sm.space_id FROM public.space_members sm WHERE sm.user_id = p.id
     ) u) AS space_count
  FROM public.profiles p
  ORDER BY p.created_at ASC;
$$;

-- 仅 service_role 可调用（函数以定义者身份绕过 RLS 读全量，下放有越权风险）。
-- 注意：Supabase 默认 ALTER DEFAULT PRIVILEGES 会让 postgres 在 public schema
-- 新建函数时自动授权 anon/authenticated/service_role 执行；本函数绕过 RLS 读全量
-- 账户（邮箱+空间个数），必须显式撤销 PUBLIC/anon/authenticated，只留 service_role。
REVOKE EXECUTE ON FUNCTION public.admin_list_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts() TO service_role;
