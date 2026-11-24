import { Router } from "express";
import { z } from "zod";
import { chatJson } from "../lib/deepseek";
import {
  buildBusy,
  conflictsAt,
  findConflictPairs,
  occupantsOf,
  parseTime,
  type OccupancyTodo,
} from "../lib/occupancy";
import {
  assertSpaceMember,
  listSpaceMembers,
  listUserSpaceIds,
} from "../lib/space";
import { createAdminClient } from "../lib/supabase";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { checkConflicts } from "../services/todos";

const bodySchema = z
  .object({
    space_id: z.string().uuid().optional(),
    all_spaces: z.boolean().optional().default(false),
    user_id: z.string().uuid().optional(),
    confirm: z.boolean().optional().default(false),
  })
  .refine((d) => d.all_spaces || d.space_id, {
    message: "需要 space_id 或 all_spaces",
  });

type MoveSuggestion = {
  todo_id: string;
  title: string;
  from_start_at: string;
  from_end_at: string;
  to_start_at: string;
  to_end_at: string;
  reason: string;
};

const TODO_SELECT =
  "id, space_id, title, priority, start_at, end_at, status, creator_id, is_all_day, todo_assignees(user_id)";

export const aiConflictSuggestRouter = Router();

aiConflictSuggestRouter.post(
  "/conflict-suggest",
  requireAuth,
  async (req, res) => {
    try {
      const auth = (req as AuthedRequest).auth!;
      const body = bodySchema.parse(req.body);
      const admin = createAdminClient();

      const spaceIds = body.all_spaces
        ? await listUserSpaceIds(admin, auth.user.id)
        : [body.space_id!];

      if (spaceIds.length === 0) {
        res.json({ conflicts: [], suggestions: [], message: "没有可访问的空间" });
        return;
      }

      if (!body.all_spaces) {
        await assertSpaceMember(admin, body.space_id!, auth.user.id);
      }

      // 显式指定 user_id 时只检测该用户的个人日程；
      // 未指定时检测所选范围（空间/全部空间）内的全部排期——按「共享占用者」判冲突。
      // 历史 bug：以前默认只取「当前登录用户相关」的任务，管理员/owner 登录时
      // 自己名下只有个别任务，空间里其他成员撞车的时间段会被整片滤掉 → 报「未检测到冲突」。
      const scopedUserId = body.user_id;

      if (scopedUserId && !body.all_spaces) {
        const members = await listSpaceMembers(admin, body.space_id!);
        if (!members.some((m) => m.user_id === scopedUserId)) {
          res.status(400).json({ error: "user_id is not in this space" });
          return;
        }
      }

      // 注意：不能用 todo_assignees!inner + eq(user_id)——
      // 那会把「未指派、创建人是本人」的任务整条过滤掉，造成漏检。
      const { data: allTodos, error } = await admin
        .from("todos")
        .select(TODO_SELECT)
        .in("space_id", spaceIds)
        .neq("status", "done")
        .not("start_at", "is", null)
        .order("start_at", { ascending: true });

      if (error) throw new Error(error.message);

      const rows = (allTodos ?? []) as unknown as OccupancyTodo[];
      // 指定了 user_id → 只看该用户占用（指派人/创建人兜底）的已排期任务；
      // 未指定 → 范围内全部已排期任务，冲突由「共享占用者」判定。
      const scheduled = scopedUserId
        ? rows.filter((t) => occupantsOf(t).includes(scopedUserId))
        : rows;

      const conflicts = findConflictPairs(scheduled, scopedUserId);

      const ownerIds = new Set<string>();
      for (const t of scheduled) for (const uid of occupantsOf(t)) ownerIds.add(uid);

      if (conflicts.length === 0) {
        res.json({
          conflicts: [],
          conflicts_detail: [],
          suggestions: [],
          message:
            scheduled.length > 0
              ? `已检查 ${scheduled.length} 项已排期任务（涉及 ${ownerIds.size} 位成员），未检测到时间重叠`
              : "当前没有已排期的任务，无需检测",
        });
        return;
      }

      const conflictIds = new Set<string>();
      for (const c of conflicts) {
        conflictIds.add(c.a);
        conflictIds.add(c.b);
      }

      const conflictsDetail = scheduled
        .filter((t) => conflictIds.has(t.id))
        .map((t) => ({
          id: t.id,
          title: t.title,
          start_at: t.start_at,
          end_at: t.end_at,
          assignees: occupantsOf(t),
        }));

      const parsed = await chatJson<{ suggestions: MoveSuggestion[] }>({
        system: `你是日程冲突解决助手。给定一批互相冲突的已排期待办（可能跨空间、可能涉及多人），建议把较低优先级任务挪到空闲时段。
只输出 JSON：
{
  "suggestions": [
    {
      "todo_id": "uuid",
      "title": "标题",
      "from_start_at": "ISO",
      "from_end_at": "ISO",
      "to_start_at": "ISO",
      "to_end_at": "ISO",
      "reason": "原因"
    }
  ]
}
规则：
- 只调整冲突任务，不要动无冲突任务
- 新时间必须避开该任务占用者（todo_assignees，为空则 creator_id）的全部已有安排，不得与任何已占用时段重叠
- 尽量保持原时长的任务不变、只移动低优先级任务`,
        user: JSON.stringify({
          scope: body.all_spaces ? "all_spaces" : "single_space",
          filter_user_id: scopedUserId ?? null,
          checked_todo_count: scheduled.length,
          member_count: ownerIds.size,
          todos: scheduled,
          conflict_pairs: conflicts,
          conflict_todo_ids: [...conflictIds],
          now: new Date().toISOString(),
        }),
      });

      const suggestions = (parsed.suggestions || []).filter((s) =>
        conflictIds.has(s.todo_id),
      );

      if (suggestions.length === 0) {
        res.json({
          conflicts,
          conflicts_detail: conflictsDetail,
          suggestions: [],
          message: `检测到 ${conflicts.length} 处冲突，但 AI 未能给出调整建议`,
        });
        return;
      }

      if (!body.confirm) {
        res.json({
          preview: true,
          conflicts,
          conflicts_detail: conflictsDetail,
          suggestions,
          message: `检测到 ${conflicts.length} 处时间重叠，给出 ${suggestions.length} 条调整建议`,
        });
        return;
      }

      // 应用前二次校验：新时间不得与该用户其它安排重叠（按占用者=指派人/创建人）
      const busy = buildBusy(rows);
      const applied: string[] = [];
      const skipped: Array<{ todo_id: string; title: string; reason: string }> =
        [];

      for (const s of suggestions) {
        const todo = scheduled.find((t) => t.id === s.todo_id);
        if (!todo) continue;

        const toStart = parseTime(s.to_start_at);
        const toEnd = parseTime(s.to_end_at);
        if (Number.isNaN(toStart) || Number.isNaN(toEnd) || toEnd <= toStart) {
          skipped.push({
            todo_id: s.todo_id,
            title: todo.title,
            reason: "AI 返回的时间无效",
          });
          continue;
        }

        const owners = occupantsOf(todo);
        const clash = conflictsAt(
          busy,
          owners,
          { start: toStart, end: toEnd },
          new Set([todo.id]),
        );
        if (clash.length > 0) {
          skipped.push({
            todo_id: s.todo_id,
            title: todo.title,
            reason: `新时间仍与「${clash[0].title}」重叠`,
          });
          continue;
        }

        for (const uid of owners) {
          const dbConflicts = await checkConflicts({
            admin,
            spaceId: todo.space_id as string,
            userId: uid,
            startAt: s.to_start_at,
            endAt: s.to_end_at,
            excludeTodoId: todo.id,
          });
          if (dbConflicts.length > 0) {
            skipped.push({
              todo_id: s.todo_id,
              title: todo.title,
              reason: "数据库校验发现新时间仍有冲突",
            });
            break;
          }
        }
        if (skipped.some((x) => x.todo_id === s.todo_id)) continue;

        const { error: upErr } = await admin
          .from("todos")
          .update({
            start_at: s.to_start_at,
            end_at: s.to_end_at,
          })
          .eq("id", s.todo_id)
          .eq("space_id", todo.space_id);
        if (upErr) throw new Error(upErr.message);
        applied.push(s.todo_id);
      }

      await admin.from("ai_actions").insert({
        space_id: spaceIds[0],
        user_id: auth.user.id,
        action_type: "conflict_suggest",
        payload: {
          conflicts,
          suggestions,
          skipped,
          all_spaces: body.all_spaces,
        },
        result_todo_ids: applied,
        status: "applied",
      });

      res.json({
        preview: false,
        conflicts,
        conflicts_detail: conflictsDetail,
        suggestions,
        applied,
        skipped,
        message: skipped.length
          ? `已调整 ${applied.length} 条，${skipped.length} 条因新时间仍有冲突被跳过`
          : `已调整 ${applied.length} 条`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const status = message.includes("Not a member") ? 403 : 400;
      res.status(status).json({ error: message });
    }
  },
);
