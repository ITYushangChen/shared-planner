import { Suspense } from "react";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { getAppAuth, getMySpaceNav, visibleSpaceNav } from "@/lib/app-data";
import { TODO_SELECT, type TodoRow } from "@/lib/todos";
import {
  buildReportData,
  filterTodosForRange,
  parseReportInput,
  parseReportSpaceIds,
  parseReportType,
  resolveReportRange,
  splitBacklogTodos,
  stripReportData,
} from "@/lib/reports";

// 报表工作区是重客户端组件（含表格构建 + exceljs 导出封装），拆为独立 chunk，
// 进入 /app/reports 时先出 SSR HTML，客户端 JS 并行异步加载，降低首屏 TTI。
const ReportWorkspace = dynamic(
  () =>
    import("./report-workspace").then((m) => ({ default: m.ReportWorkspace })),
);

type SearchParams = Promise<{
  type?: string;
  date?: string;
  spaces?: string;
  /** 周报「只看我的任务」开关：缺省=开（个人周报），显式 "0"=关（团队视图） */
  mine?: string;
}>;

const ACTIVE_TODO_LIMIT = 2000;
const DONE_TODO_LIMIT = 1000;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const { supabase, user } = await getAppAuth();

  if (!user) {
    redirect("/login");
  }

  const { spaces: allSpaces } = await getMySpaceNav();
  const spaces = visibleSpaceNav(allSpaces);
  const type = parseReportType(sp.type);
  const input = parseReportInput(type, sp.date);
  const range = resolveReportRange(type, input || sp.date);
  const selectedSpaceIds = parseReportSpaceIds(sp.spaces, spaces);
  const selectedSpaces = spaces.filter((s) =>
    selectedSpaceIds.includes(s.id),
  );
  const canAssignBySpace = Object.fromEntries(
    spaces.map((s) => [s.id, s.role === "owner" || s.role === "admin"]),
  );
  // 周报默认「只看我的任务」（个人周报）；显式 mine=0 才切到团队视图
  const mineOnly = sp.mine !== "0";

  const emptyTodos = { data: [] as never[], error: null };
  const spaceIds =
    selectedSpaces.length > 0
      ? selectedSpaces.map((s) => s.id)
      : spaces.map((s) => s.id);

  // ⚠️ 此前完全没有时间条件：每次进报告页都拉该空间全部历史任务
  // （两千条且带 description，数 MB 载荷），「日报」里混着几个月前的待办。
  // 现在先在 SQL 侧粗筛（同时大幅瘦身），再在 JS 侧用区间相交精筛。
  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();

  const [activeRes, doneRes] =
    spaceIds.length > 0
      ? await Promise.all([
          supabase
            .from("todos")
            .select(TODO_SELECT)
            .in("space_id", spaceIds)
            .neq("status", "done")
            // 未排期（start_at 为空）始终保留；其余只保留「已开始且未落在未来」的
            .or(`start_at.is.null,start_at.lte.${endIso}`)
            .order("created_at", { ascending: false })
            .limit(ACTIVE_TODO_LIMIT),
          supabase
            .from("todos")
            .select(TODO_SELECT)
            .in("space_id", spaceIds)
            .eq("status", "done")
            // 已完成任务按完成时间落在本周期内
            .gte("completed_at", startIso)
            .lte("completed_at", endIso)
            .order("completed_at", { ascending: false })
            .limit(DONE_TODO_LIMIT),
        ])
      : [emptyTodos, emptyTodos];

  const fetchError = activeRes.error ?? doneRes.error;
  const rawTodos = filterTodosForRange(
    [
      ...((activeRes.data ?? []) as unknown as TodoRow[]),
      ...((doneRes.data ?? []) as unknown as TodoRow[]),
    ],
    range.start,
    range.end,
  );
  const taskLimitReached =
    (activeRes.data?.length ?? 0) >= ACTIVE_TODO_LIMIT ||
    (doneRes.data?.length ?? 0) >= DONE_TODO_LIMIT;

  // 未排期 backlog 单独成块：不计入完成率与统计卡，只在报告底部列出提醒排期
  const { ranged, backlog } = splitBacklogTodos(rawTodos);

  const data = buildReportData({
    type,
    range,
    selectedSpaces,
    todos: ranged,
    canAssignBySpace,
    userId: user.id,
    mineOnly,
  });
  const backlogData =
    backlog.length > 0
      ? buildReportData({
          type,
          range,
          selectedSpaces,
          todos: backlog,
          canAssignBySpace,
          userId: user.id,
          mineOnly,
        })
      : null;

  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={null}>
        <ReportWorkspace
          spaces={spaces}
          type={type}
          input={data.input}
          selectedSpaceIds={selectedSpaceIds}
          viewData={stripReportData(data)}
          backlogSpaces={backlogData?.spaces ?? []}
          fetchError={fetchError?.message ?? null}
          taskLimitReached={taskLimitReached}
          mineOnly={mineOnly}
        />
      </Suspense>
    </main>
  );
}
