"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { calendarTitleVariants } from "@/lib/calendar-title";

/**
 * 日历卡片里的标题：只这一行字，按列宽自动选形态。
 *   完整「离散数学及其应用 · 2.1 集合（1/2）」
 *   → 短形态「离散，2，1集合（1/2）」
 *   → 只留章节号「2.1（1/2）」
 * 三档都放不下才交给 CSS 省略号兜底。
 */
export function CalendarEventTitle({
  title,
  className,
}: {
  title: string;
  className: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const variants = useMemo(() => calendarTitleVariants(title), [title]);
  // 0 = 完整，数值越大越短
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (variants.length <= 1) {
      setLevel(0);
      return;
    }
    let raf = 0;
    let ctx: CanvasRenderingContext2D | null = null;
    const measure = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const style = window.getComputedStyle(el);
      const fontSize = parseFloat(style.fontSize) || 14;
      if (!ctx) ctx = document.createElement("canvas").getContext("2d");
      let widths: number[];
      if (ctx) {
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        widths = variants.map((v) => ctx!.measureText(v).width);
      } else {
        widths = variants.map((v) => v.length * fontSize * 0.9);
      }
      setLevel((prev) => {
        // 当前宽度下能放下的最长形态（变体是从长到短排列，取第一个放得下的）
        let best = -1;
        for (let i = 0; i < widths.length; i++) {
          if (widths[i]! <= width - 1) {
            best = i;
            break;
          }
        }
        // 连最短形态都放不下：用最短的，交给省略号
        if (best < 0) return widths.length - 1;
        // 索引越大越短：需要变短时立刻切；想变回长形态要留更宽的余量，避免临界抖动
        if (best > prev) return best;
        if (best < prev) return widths[best]! <= width - 6 ? best : prev;
        return best;
      });
    };
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(measure);
    };
    schedule();
    // 字体加载完成后字宽会变，需要重算一次
    if (document.fonts?.ready) void document.fonts.ready.then(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [variants]);

  const text = variants[Math.min(level, variants.length - 1)] ?? title;

  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}
