import Link from "next/link";

/**
 * 页面左上「返回」按钮。
 *
 * 配色与全站次级按钮统一（2026-11-02）：白底 + 细蓝边 + 深蓝字，
 * hover 铺浅蓝底。之前是 bg-zinc-900 黑底白字，与同页的蓝描边按钮
 * （如空间页「输入邀请码加入」）并排时视觉割裂，故改为同一色系。
 */
export function BackToAppButton({ label = "返回" }: { label?: string }) {
  return (
    <Link
      href="/app?view=calendar&range=week"
      className="inline-flex rounded-xl border border-[#2f5f8f]/55 bg-white px-4 py-2 text-sm font-medium text-[#2f5f8f] transition-colors duration-200 hover:bg-[#e8f0f7]"
    >
      {label}
    </Link>
  );
}
