/**
 * 功能 B「每日学习量自动校准」纯函数自测。
 *
 * 运行：node_modules/.bin/tsx scripts/calibration-selftest.ts
 *
 * 只测不依赖 DB 的纯函数：
 *  - roundToStep           四舍五入到 5 分钟网格
 *  - computeLastNaturalWeek 上一自然周（周一边界）换算
 *  - computeNewDailyCap    平均/7 → 舍入 → clamp 下限 15 / 上界窗口
 */

import {
  computeLastNaturalWeek,
  computeNewDailyCap,
  roundToStep,
} from "../src/lib/study-daily-calibration";

const TZ = "Asia/Shanghai"; // 无 DST，恒 +08:00

let failed = 0;
let passed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log("    实际：", JSON.stringify(detail));
  }
}

/* ------------------------------- roundToStep ------------------------------- */

check("roundToStep(0) = 0", roundToStep(0) === 0);
check("roundToStep(12) = 10", roundToStep(12) === 10);
check("roundToStep(13) = 15", roundToStep(13) === 15);
check("roundToStep(17.5) = 20", roundToStep(17.5) === 20);
check("roundToStep(100) = 100", roundToStep(100) === 100);

/* --------------------------- computeLastNaturalWeek ------------------------ */

// 今天 = 周一（2026-11-23 确为周一）：thisMonday=11-23，lastMonday=11-16
{
  const w = computeLastNaturalWeek(TZ, "2026-11-23");
  check("周一：mondayKey=2026-11-16", w.mondayKey === "2026-11-16", w.mondayKey);
  check(
    "周一：startIso=2026-11-15T16:00Z",
    w.startIso === "2026-11-15T16:00:00.000Z",
    w.startIso,
  );
  check(
    "周一：endIso=2026-11-22T16:00Z",
    w.endIso === "2026-11-22T16:00:00.000Z",
    w.endIso,
  );
}

// 今天 = 周日（2026-11-22）：thisMonday=11-16，lastMonday=11-09
{
  const w = computeLastNaturalWeek(TZ, "2026-11-22");
  check("周日：mondayKey=2026-11-09", w.mondayKey === "2026-11-09", w.mondayKey);
  check(
    "周日：startIso=2026-11-08T16:00Z",
    w.startIso === "2026-11-08T16:00:00.000Z",
    w.startIso,
  );
}

// 今天 = 周三（2026-11-25）：thisMonday=11-23，lastMonday=11-16
{
  const w = computeLastNaturalWeek(TZ, "2026-11-25");
  check("周三：mondayKey=2026-11-16", w.mondayKey === "2026-11-16", w.mondayKey);
  check(
    "周三：startIso=2026-11-15T16:00Z",
    w.startIso === "2026-11-15T16:00:00.000Z",
    w.startIso,
  );
}

// 跨月：今天 = 2026-12-01（周二）→ thisMonday=11-30，lastMonday=11-23
{
  const w = computeLastNaturalWeek(TZ, "2026-12-01");
  check("跨月：mondayKey=2026-11-23", w.mondayKey === "2026-11-23", w.mondayKey);
}

/* ---------------------------- computeNewDailyCap --------------------------- */

// 无数据 → null
check("无数据(0)→null", computeNewDailyCap(0, 90) === null);
check("无数据(负)→null", computeNewDailyCap(-3, 90) === null);

// 平均 /7
check("700/7=100,窗口180→100", computeNewDailyCap(700, 180) === 100);

// 上界 clamp 到窗口长度
check("700/7=100,窗口90→90", computeNewDailyCap(700, 90) === 90);

// 下限 clamp 到 15
check("37→avg5.28→15", computeNewDailyCap(37, 90) === 15);

// 舍入到 5 网格后再 clamp
check("123→avg17.57→round20", computeNewDailyCap(123, 90) === 20);
check("120→avg17.14→round15", computeNewDailyCap(120, 90) === 15);

// 窗口极端：窗口 0 时上界压过下限 → 0（退化为「排不进任何块」，语义正确）
check("窗口0时上界压过下限→0", computeNewDailyCap(700, 0) === 0);

/* --------------------------------- 汇总 ----------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
