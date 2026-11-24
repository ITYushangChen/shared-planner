/**
 * 日历卡片标题的三级形态（从长到短）。
 *
 * 学习计划生成的待办标题形如「离散数学及其应用 · 2.1 集合（1/2）」，
 * 在日历列宽里必然显示不全。逐级压缩：
 *   一级（完整）：离散数学及其应用 · 2.1 集合（1/2）
 *   二级（短形态）：离散，2，1集合（1/2）
 *   三级（只留章节号）：2.1（1/2）
 */

/** 按「 · 」拆成「主名」「单元」两段；没有分隔符时整串算单元 */
function splitTitle(raw: string): { head: string; tail: string; hasSep: boolean } {
  const parts = (raw || "")
    .split(/\s*·\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return { head: parts[0]!, tail: parts.slice(1).join(" "), hasSep: true };
  }
  return { head: "", tail: parts[0] ?? "", hasSep: false };
}

/** 章节号压缩：2.1 集合 → 2，1集合 */
const squashUnit = (s: string) => s.replace(/\s+/g, "").replace(/\.(?=\d)/g, "，");

/**
 * 二级形态：放不下完整标题时用。
 *   1. 主名取中文片段前 2 字（离散数学及其应用 → 离散）；纯英文主名原样保留，避免「Ro」残词；
 *   2. 章节号里的点换成逗号、去掉空格（2.1 集合 → 2，1集合）；
 *   3. 用中文逗号连接。
 * 「离散数学及其应用 · 2.1 集合（1/2）」→「离散，2，1集合（1/2）」
 */
export function compactCalendarTitle(raw: string): string {
  const title = (raw || "").trim();
  if (!title) return title;

  const { head, tail, hasSep } = splitTitle(title);

  if (hasSep) {
    const cjk = head.match(/[\u4e00-\u9fa5]+/);
    const shortHead = cjk
      ? cjk[0]!.length > 2
        ? cjk[0]!.slice(0, 2)
        : cjk[0]!
      : head;
    return `${shortHead}，${squashUnit(tail)}`;
  }

  // 没有「 · 」结构：只有章节号时（2.1 集合（1/2））才做压缩，其余原样返回
  if (/^\d+(?:\.\d+)+/.test(title)) return squashUnit(title);
  return title;
}

/**
 * 三级形态：只留章节号（+ 分册标记），列宽极窄时的兜底。
 * 「离散数学及其应用 · 2.1 集合（1/2）」→「2.1（1/2）」
 * 「离散数学及其应用 · 6.4 树和森林」 →「6.4」
 * 取不出章节号时返回空串（表示没有这一级可用）。
 */
export function sectionOnlyCalendarTitle(raw: string): string {
  const title = (raw || "").trim();
  if (!title) return "";

  const { tail } = splitTitle(title);
  const num = tail.match(/\d+(?:\.\d+)*/)?.[0] ?? "";
  if (!num) return "";
  // 分册标记（1/2）要留着，否则「(1/2)」「(2/2)」两块看起来一模一样
  const part = tail.match(/[（(][^）)]*[）)]/)?.[0] ?? "";
  return `${num}${part}`;
}

/**
 * 某条标题可用的所有形态，从长到短、去掉重复。
 * 返回长度恒 ≥ 1（第一个元素就是原串）。
 */
export function calendarTitleVariants(raw: string): string[] {
  const title = (raw || "").trim();
  if (!title) return [title];
  const candidates = [title, compactCalendarTitle(title), sectionOnlyCalendarTitle(title)];
  const out: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    if (out[out.length - 1] === c) continue;
    out.push(c);
  }
  return out;
}
