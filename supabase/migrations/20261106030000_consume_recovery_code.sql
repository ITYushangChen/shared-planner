-- 加固：恢复码「消费即焚」
-- 问题：原 verify_recovery_code 命中后只返回 uid，码仍留在表里，可反复用于重置密码。
--   若恢复码泄露，攻击者在用户改密/管理员重发前能无限次重置密码。
-- 修复：命中成功后立即把 recovery_code_hash 置 NULL，码即作废，下次必须重新签发。
--   （重新签发途径：用户改密时自动重发 / 设置页重生成 / 管理员 admin-recovery regen）
-- 注意：依赖 pgcrypto 的 crypt()，search_path 必须含 extensions（与原函数一致）。

CREATE OR REPLACE FUNCTION public.verify_recovery_code(
  p_email TEXT,
  p_code TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id UUID;
  v_hash TEXT;
BEGIN
  SELECT id, recovery_code_hash INTO v_id, v_hash
  FROM public.profiles
  WHERE email = p_email;

  IF v_id IS NULL OR v_hash IS NULL THEN
    RETURN NULL;
  END IF;
  IF crypt(p_code, v_hash) = v_hash THEN
    -- 消费即焚：验证成功后立即作废，防止恢复码被反复滥用
    UPDATE public.profiles
    SET recovery_code_hash = NULL
    WHERE id = v_id;
    RETURN v_id;
  END IF;
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_recovery_code(TEXT, TEXT) TO authenticated, anon;

COMMENT ON COLUMN public.profiles.recovery_code_hash IS
  '密码找回码哈希（crypt bf）。NULL 表示未设置或已消费；注册/改密/管理员重发时生成并展示一次，验证成功后即焚';
