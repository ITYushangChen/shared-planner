/**
 * 学习计划装箱算法 + 章节切分的确定性自测。
 *
 * 运行：node_modules/.bin/tsx scripts/study-selftest.ts
 *
 * 用固定日期（2027-03-01 是周一）+ 注入的 now，保证每次跑结果完全一致。
 */

import {
  addDays,
  countStudyDays,
  hmInTz,
  packStudyPlan,
  weekdayOf,
  zonedToUtc,
  type StudyUnit,
} from "../src/lib/study-packing";
import {
  chaptersToUnits,
  groupSlotsByDate,
  normalizeChapters,
} from "../src/services/study";

const TZ = "Asia/Shanghai";
const NOW = Date.UTC(2027, 1, 28, 4, 0); // 2027-02-28 12:00 北京时间，早于所有测试起始日

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

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), {
    actual,
    expected,
  });
}

function units(spec: Array<[string, number]>): StudyUnit[] {
  return spec.map(([title, minutes], i) => ({
    seq: i + 1,
    title,
    chapter_no: i + 1,
    minutes,
  }));
}

/** 「日期 起-止」便于断言 */
function slotText(s: { date: string; start_ms: number; end_ms: number }) {
  return `${s.date} ${hmInTz(s.start_ms, TZ)}-${hmInTz(s.end_ms, TZ)}`;
}

/* -------------------------------------------------------------------------- */
console.log("\n[1] 时区换算");
eq(
  "20:00 Asia/Shanghai = 12:00 UTC",
  zonedToUtc("2027-03-01", "20:00", TZ),
  Date.UTC(2027, 2, 1, 12, 0),
);
eq("回读墙上时间", hmInTz(Date.UTC(2027, 2, 1, 12, 0), TZ), "20:00");
eq("2027-03-01 是周一", weekdayOf("2027-03-01"), 1);
eq("跨月加天数", addDays("2027-02-28", 1), "2027-03-01");
eq(
  "周一至周五算 5 个学习日",
  countStudyDays("2027-03-01", "2027-03-05", [1, 2, 3, 4, 5]),
  5,
);

/* -------------------------------------------------------------------------- */
console.log("\n[2] 基本装箱：20:00–21:30 放两个 45 分钟单元");
const base = packStudyPlan({
  units: units([
    ["1.1 命题逻辑", 45],
    ["1.2 谓词逻辑", 45],
  ]),
  startDate: "2027-03-01",
  weekdays: [1, 2, 3, 4, 5],
  dailyStart: "20:00",
  dailyEnd: "21:30",
  timezone: TZ,
  now: NOW,
});
eq("两块落在同一天", base.slots.map(slotText), [
  "2027-03-01 20:00-20:45",
  "2027-03-01 20:45-21:30",
]);
eq("没有排不进去的单元", base.unplaced.length, 0);
eq("总分钟数", base.total_minutes, 90);
eq("按天分组只有一天", groupSlotsByDate(base.slots).map((d) => d.date), [
  "2027-03-01",
]);

/* -------------------------------------------------------------------------- */
console.log("\n[3] 避让已有日程：20:00–20:45 被占");
const conflict = packStudyPlan({
  units: units([
    ["1.1 命题逻辑", 45],
    ["1.2 谓词逻辑", 45],
  ]),
  startDate: "2027-03-01",
  weekdays: [1, 2, 3, 4, 5],
  dailyStart: "20:00",
  dailyEnd: "21:30",
  timezone: TZ,
  now: NOW,
  userIds: ["u1"],
  busy: [
    {
      user_id: "u1",
      start: zonedToUtc("2027-03-01", "20:00", TZ),
      end: zonedToUtc("2027-03-01", "20:45", TZ),
    },
  ],
});
eq("首块顺延到 20:45，第二块推到次日", conflict.slots.map(slotText), [
  "2027-03-01 20:45-21:30",
  "2027-03-02 20:00-20:45",
]);

console.log("\n[3b] 别人的日程不该影响我（userIds 过滤）");
const otherUser = packStudyPlan({
  units: units([["1.1 命题逻辑", 45]]),
  startDate: "2027-03-01",
  weekdays: [1, 2, 3, 4, 5],
  dailyStart: "20:00",
  dailyEnd: "21:30",
  timezone: TZ,
  now: NOW,
  userIds: ["u1"],
  busy: [
    {
      user_id: "u2",
      start: zonedToUtc("2027-03-01", "20:00", TZ),
      end: zonedToUtc("2027-03-01", "21:30", TZ),
    },
  ],
});
eq("仍排在 20:00", otherUser.slots.map(slotText), [
  "2027-03-01 20:00-20:45",
]);

/* -------------------------------------------------------------------------- */
console.log("\n[4] 跳过周末：周五开排，第二块到周一");
const weekend = packStudyPlan({
  units: units([
    ["第1章", 90],
    ["第2章", 90],
  ]),
  startDate: "2027-03-05", // 周五
  weekdays: [1, 2, 3, 4, 5],
  dailyStart: "20:00",
  dailyEnd: "21:30",
  timezone: TZ,
  now: NOW,
});
eq("周五 → 周一", weekend.slots.map(slotText), [
  "2027-03-05 20:00-21:30",
  "2027-03-08 20:00-21:30",
]);

/* -------------------------------------------------------------------------- */
console.log("\n[5] 每日上限：cap=60 时 90 分钟窗口只排一块");
const capped = packStudyPlan({
  units: units([
    ["1.1", 45],
    ["1.2", 45],
  ]),
  startDate: "2027-03-01",
  weekdays: [1, 2, 3, 4, 5],
  dailyStart: "20:00",
  dailyEnd: "21:30",
  dailyMinutesCap: 60,
  timezone: TZ,
  now: NOW,
});
eq("一天只放一块", capped.slots.map(slotText), [
  "2027-03-01 20:00-20:45",
  "2027-03-02 20:00-20:45",
]);

/* -------------------------------------------------------------------------- */
console.log("\n[6] deadline 倒排核算：3 天窗口装不下 450 分钟");
const tight = packStudyPlan({
  units: units([
    ["单元1", 45],
    ["单元2", 45],
    ["单元3", 45],
    ["单元4", 45],
    ["单元5", 45],
    ["单元6", 45],
    ["单元7", 45],
    ["单元8", 45],
    ["单元9", 45],
    ["单元10", 45],
  ]),
  startDate: "2027-03-01",
  weekdays: [1, 2, 3, 4, 5],
  dailyStart: "20:00",
  dailyEnd: "21:30",
  timezone: TZ,
  now: NOW,
  deadline: "2027-03-03",
});
const fit = tight.deadline_fit!;
eq("判定为不可行", fit.feasible, false);
eq("截止前容量 270 分钟", fit.capacity_minutes, 270);
eq("缺口 180 分钟", fit.deficit_minutes, 180);
eq("3 个可用日", fit.available_days, 3);
eq("每天需多学 60 分钟", fit.extra_per_day, 60);
check(
  "给出缺口提示",
  tight.warnings.some((w) => w.includes("差 180 分钟")),
  tight.warnings,
);

console.log("\n[6b] deadline 宽裕时提前完成");
const loose = packStudyPlan({
  units: units([["单元1", 45]]),
  startDate: "2027-03-01",
  weekdays: [1, 2, 3, 4, 5],
  dailyStart: "20:00",
  dailyEnd: "21:30",
  timezone: TZ,
  now: NOW,
  deadline: "2027-03-31",
});
eq("可行", loose.deadline_fit!.feasible, true);
check(
  "提示提前完成天数",
  loose.warnings.some((w) => w.includes("提前 30 天")),
  loose.warnings,
);

/* -------------------------------------------------------------------------- */
console.log("\n[7] 章节切分：100 分钟的节在 unitMinutes=45 下拆 3 段");
const splitUnits = chaptersToUnits(
  normalizeChapters([{ no: 1, title: "1.1 命题逻辑", minutes: 100 }], 60),
  45,
);
eq("拆成 3 段", splitUnits.length, 3);
eq("标题带序号", splitUnits.map((u) => u.title), [
  "1.1 命题逻辑（1/3）",
  "1.1 命题逻辑（2/3）",
  "1.1 命题逻辑（3/3）",
]);
eq("总时长不丢", splitUnits.reduce((s, u) => s + u.minutes, 0), 100);

console.log("\n[8] 叶子优先：父章 300 分钟不重复计时");
const leafUnits = chaptersToUnits(
  normalizeChapters(
    [
      { no: 1, title: "第1章 集合", level: 1, minutes: 300 },
      { no: 2, title: "1.1 集合的概念", level: 2, parent_no: 1, minutes: 150 },
      { no: 3, title: "1.2 集合的运算", level: 2, parent_no: 1, minutes: 150 },
    ],
    60,
  ),
  45,
);
eq("只排子节，不排父章", leafUnits.every((u) => u.chapter_no !== 1), true);
eq("总时长仍是 300", leafUnits.reduce((s, u) => s + u.minutes, 0), 300);
check(
  "每段不超过 45 分钟",
  leafUnits.every((u) => u.minutes <= 45),
  leafUnits,
);

console.log("\n[9] 脏数据清洗：缺标题丢掉、重复编号重编、悬空父级置空");
const cleaned = normalizeChapters(
  [
    { no: 1, title: "   ", minutes: 60 },
    { no: 2, title: "有效章节", minutes: 0 },
    { no: 2, title: "重复编号", minutes: 30 },
    { no: 4, title: "悬空父级", parent_no: 99, minutes: 30 },
  ],
  60,
);
eq("丢掉空标题", cleaned.length, 3);
eq("编号唯一", new Set(cleaned.map((c) => c.no)).size, 3);
eq("悬空父级置空", cleaned[2].parent_no, null);
eq("分钟数兜底", cleaned[0].minutes, 60);

/* -------------------------------------------------------------------------- */
console.log(
  `\n结果：${passed} 通过 / ${failed} 失败${failed === 0 ? " ✅" : " ❌"}`,
);
process.exit(failed === 0 ? 0 : 1);
