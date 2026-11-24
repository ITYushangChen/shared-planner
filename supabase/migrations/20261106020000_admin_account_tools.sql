-- =============================================================================
-- 第 1 层「账号管控」：封禁 + 恢复码吊销
-- 配套路由：/auth/admin-ban、/auth/admin-signout、/auth/admin-delete、/auth/admin-recovery
-- 配套前端：设置页「管理员工具」下的封禁/强制下线/删除/恢复码 tab
-- =============================================================================

-- 1) profiles 增加封禁字段
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_reason TEXT;

COMMENT ON COLUMN public.profiles.banned IS
  '是否被封禁；封禁后登录会被 middleware 拒绝并强制登出（Supabase 登录本身不读此列，靠 middleware 拦截）';
COMMENT ON COLUMN public.profiles.banned_at IS '封禁时间';
COMMENT ON COLUMN public.profiles.banned_reason IS '封禁原因（管理员填写，可空）';

-- 2) 判断某用户是否被封禁：middleware 在每次整页加载（getUser 之后）调用。
--    SECURITY DEFINER + search_path=public，避免 RLS/角色切换踩坑。
CREATE OR REPLACE FUNCTION public.is_user_banned(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT banned FROM public.profiles WHERE id = p_user_id), FALSE);
$$;

GRANT EXECUTE ON FUNCTION public.is_user_banned(UUID) TO authenticated, anon;

-- 3) 吊销恢复码（置 NULL，不可恢复；用户将只能找管理员重置）
CREATE OR REPLACE FUNCTION public.revoke_recovery_code(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  UPDATE public.profiles SET recovery_code_hash = NULL WHERE id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_recovery_code(UUID) TO authenticated;
