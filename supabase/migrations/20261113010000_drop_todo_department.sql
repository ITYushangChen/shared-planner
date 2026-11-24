-- 2026-11-13 全局移除任务「部门」字段
-- 部门概念不再需要，删除 todos.department 列（含其 NOT NULL / DEFAULT / CHECK / COMMENT 一并随列删除）。
ALTER TABLE public.todos DROP COLUMN IF EXISTS department;
