-- 问题③：管理员协助重置密码（关闭「恢复码丢失」这个死胡同）
-- 现状：忘记密码只能凭「一次性恢复码」重置（因为 SMTP 是假的，发不了邮件）。
--       如果用户把恢复码也弄丢了，目前没有任何途径进得去，只能干瞪眼。
-- 方案：引入一个全局「应用管理员」标志 is_admin。管理员登录后，可在 /admin/reset
--       凭目标邮箱强改其密码（服务端用 service_role 绕过会话），并同时重生成恢复码。
--       普通用户（is_admin=false）调用接口会被 403 拒绝。

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.profiles.is_admin IS
  '应用管理员标志。管理员可在登录后通过 /admin/reset 协助重置其他用户密码。'
  '默认 false，由运维手动置 true（例如 UPDATE profiles SET is_admin=true WHERE id=...）。';

-- 读取「当前登录用户」是否为管理员的辅助函数。
-- SECURITY DEFINER + search_path 固定，避免依赖调用者的 RLS 上下文；
-- 仅授权给 authenticated，供客户端页面自查权限（避免前端直接扫 profiles 暴露他人标志）。
CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_admin FROM public.profiles WHERE id = auth.uid()),
    FALSE
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_app_admin() TO authenticated;
