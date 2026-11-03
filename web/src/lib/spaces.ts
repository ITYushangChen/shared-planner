export const SPACE_KINDS = [
  { value: "personal", label: "个人空间" },
  { value: "work", label: "工作区" },
  { value: "life", label: "生活区" },
  { value: "family", label: "家庭区" },
  { value: "other", label: "其他" },
] as const;

export type SpaceKind = (typeof SPACE_KINDS)[number]["value"];

export function spaceKindLabel(kind: string | null | undefined): string {
  const hit = SPACE_KINDS.find((k) => k.value === kind);
  return hit?.label ?? kind ?? "未分类";
}

export function isSpaceKind(value: string): value is SpaceKind {
  return SPACE_KINDS.some((k) => k.value === value);
}

export const SPACE_VISIBILITIES = [
  { value: "private", label: "私人" },
  { value: "public", label: "公共" },
] as const;

export type SpaceVisibility = (typeof SPACE_VISIBILITIES)[number]["value"];

export function spaceVisibilityLabel(v: string | null | undefined) {
  if (v === "public") return "公共";
  return "私人";
}

/**
 * 注册/bootstrap 自动创建的默认空间，侧栏与总览不展示（改由 EmptySpaceGuide 引导建空间）。
 *
 * ⚠️ 判定依据**只能是**触发器写入的固定描述 `个人默认空间`（见
 * supabase/migrations/20260804000000_init_sharetodo.sql 的 handle_new_user）。
 * 2026-11-02 修：此前还用 `/的空间$/` 匹配名字，导致用户自己把空间命名为
 * 「张三的空间」「我们家的空间」时，这个空间会从侧栏、总览、报告、设置里**整体消失**，
 * 且没有任何入口能再看到它（比报错更糟：数据还在，但用户以为丢了）。
 * 该默认空间在任何 UI 里都不可达，也就无法被改名/改描述，所以 description 是稳定标记。
 */
export function isAutoDefaultSpace(s: {
  description?: string | null;
}): boolean {
  return s.description === "个人默认空间";
}
