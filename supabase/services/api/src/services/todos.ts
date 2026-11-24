import type { SupabaseClient } from "@supabase/supabase-js";

export type Priority = "high" | "medium" | "low";
export type TodoStatus = "todo" | "in_progress" | "done";

export type ParsedTodo = {
  title: string;
  description?: string | null;
  priority?: Priority;
  assignee_names?: string[];
  start_at?: string | null;
  end_at?: string | null;
  due_at?: string | null;
  is_all_day?: boolean;
  /** 预计时长（分钟）：日历按真实长度渲染，学习计划的每个块会带上 */
  duration_minutes?: number | null;
};

export type TodoPreview = ParsedTodo & {
  assignee_ids: string[];
};

export async function insertTodosWithAssignees(params: {
  admin: SupabaseClient;
  spaceId: string;
  creatorId: string;
  conversationId?: string | null;
  items: TodoPreview[];
}): Promise<string[]> {
  const todoIds: string[] = [];

  for (const item of params.items) {
    const { data: todo, error } = await params.admin
      .from("todos")
      .insert({
        space_id: params.spaceId,
        creator_id: params.creatorId,
        title: item.title,
        description: item.description ?? null,
        priority: item.priority || "medium",
        status: "todo" as TodoStatus,
        start_at: item.start_at || null,
        end_at: item.end_at || null,
        due_at: item.due_at || null,
        is_all_day: Boolean(item.is_all_day),
        duration_minutes: item.duration_minutes ?? null,
        source: "ai",
      })
      .select("id")
      .single();

    if (error || !todo) throw new Error(error?.message || "Failed to insert todo");
    todoIds.push(todo.id);

    const assignees = [...new Set(item.assignee_ids)];
    if (assignees.length > 0) {
      const { error: aerr } = await params.admin.from("todo_assignees").insert(
        assignees.map((user_id) => ({
          todo_id: todo.id,
          user_id,
        })),
      );
      if (aerr) throw new Error(aerr.message);
    }
  }

  const { error: actionError } = await params.admin.from("ai_actions").insert({
    conversation_id: params.conversationId || null,
    space_id: params.spaceId,
    user_id: params.creatorId,
    action_type: "create_todo",
    payload: { items: params.items },
    result_todo_ids: todoIds,
    status: "applied",
  });
  if (actionError) throw new Error(actionError.message);

  return todoIds;
}

export async function checkConflicts(params: {
  admin: SupabaseClient;
  spaceId: string;
  userId: string;
  startAt: string;
  endAt: string;
  excludeTodoId?: string | null;
}) {
  const { data, error } = await params.admin.rpc("check_schedule_conflicts", {
    p_space_id: params.spaceId,
    p_user_id: params.userId,
    p_start_at: params.startAt,
    p_end_at: params.endAt,
    p_exclude_todo_id: params.excludeTodoId ?? null,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

export function priorityWeight(p: Priority | string | null | undefined): number {
  if (p === "high") return 3;
  if (p === "low") return 1;
  return 2;
}

export function computeSortScore(todo: {
  priority?: string | null;
  due_at?: string | null;
  start_at?: string | null;
  status?: string | null;
}): number {
  if (todo.status === "done") return -1;
  const now = Date.now();
  const due = todo.due_at ? Date.parse(todo.due_at) : NaN;
  const hoursToDue = Number.isNaN(due)
    ? Number.POSITIVE_INFINITY
    : (due - now) / 36e5;

  let score = 0;
  if (hoursToDue < 0) {
    // 已逾期未完成：全局第一排序键，逾期越久越靠前
    score += 1_000_000 - hoursToDue; // -hoursToDue > 0
  } else if (Number.isFinite(hoursToDue)) {
    // 未逾期但有截止：越临近越靠前（封顶 100000）
    score += Math.max(0, 100_000 - hoursToDue * 100);
  }
  // 优先级降为次级权重（高+30 / 中+20 / 低+10），仅作同档区分
  score += priorityWeight(todo.priority) * 10;
  if (!todo.start_at) score += 1; // 未排期略优先于已排期（同档内）
  return Math.round(score * 100) / 100;
}
