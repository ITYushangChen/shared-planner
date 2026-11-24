import { Router } from "express";
import { z } from "zod";
import { chatJson } from "../lib/deepseek";
import {
  buildBusy,
  findFreeSlot,
  occupantsOf,
  type BusyEntry,
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
import { checkConflicts, computeSortScore } from "../services/todos";

const bodySchema = z
  .object({
    space_id: z.string().uuid().optional(),
    all_spaces: z.boolean().optional().default(false),
    text: z.string().optional(),
    todo_ids: z.array(z.string().uuid()).optional(),
    /** 是否把「未排期任务」一起纳入本次排期（前端可关掉） */
    include_unscheduled: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
    workday_start: z.string().optional().default("09:00"),
    workday_end: z.string().optional().default("18:00"),
    timezone: z.string().optional().default("Asia/Shanghai"),
  })
  .refine((d) => d.all_spaces || d.space_id, {
    message: "需要 space_id 或 all_spaces",
  });

type Suggestion = {
  todo_id: string;
  title: string;
  start_at: string;
  end_at: string;
  reason?: string;
};

/** 候选待办：额外带上 duration_minutes（AI 不再猜时长，优先用已有值） */
type CandidateTodo = OccupancyTodo & { duration_minutes?: number | null };

const TODO_SELECT =
  "id, space_id, title, description, priority, status, start_at, end_at, due_at, is_all_day, duration_minutes, creator_id, todo_assignees(user_id)";

export const aiScheduleRouter = Router();

aiScheduleRouter.post("/schedule", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = bodySchema.parse(req.body);
    const admin = createAdminClient();

    const spaceIds = body.all_spaces
      ? await listUserSpaceIds(admin, auth.user.id)
      : [body.space_id!];

    if (spaceIds.length === 0) {
      res.json({ suggestions: [], message: "没有可访问的空间" });
      return;
    }

    if (!body.all_spaces) {
      await assertSpaceMember(admin, body.space_id!, auth.user.id);
    }

    // 成员目录：单空间用该空间成员；全部空间合并去重
    const memberMap = new Map<
      string,
      { user_id: string; display_name: string }
    >();
    for (const sid of spaceIds) {
      const ms = await listSpaceMembers(admin, sid);
      for (const m of ms) {
        if (!memberMap.has(m.user_id)) {
          memberMap.set(m.user_id, {
            user_id: m.user_id,
            display_name: m.display_name,
          });
        }
      }
    }

    // 候选任务：显式 todo_ids 优先；否则按「是否纳入未排期」决定
    const explicitIds = body.todo_ids?.filter(Boolean) ?? [];
    if (explicitIds.length === 0 && !body.include_unscheduled) {
      res.status(400).json({
        error: "已关闭「纳入未排期任务」，请先勾选要排期的任务",
      });
      return;
    }

    let query = admin
      .from("todos")
      .select(TODO_SELECT)
      .in("space_id", spaceIds)
      .neq("status", "done");

    if (explicitIds.length > 0) {
      query = query.in("id", explicitIds);
    } else {
      query = query.is("start_at", null);
    }

    const { data: todos, error } = await query;
    if (error) throw new Error(error.message);
    if (!todos?.length) {
      res.json({
        suggestions: [],
        message: explicitIds.length
          ? "选中的任务没有需要排期的（可能已完成）"
          : "没有需要排期的待办",
      });
      return;
    }

    const candidates = todos as unknown as CandidateTodo[];

    // 占用者集合：有指派=指派人，无指派=创建人（与冲突检测口径一致）
    const occupantIds = [
      ...new Set(candidates.flatMap((t) => occupantsOf(t))),
    ];

    // 忙碌时段要跨空间取：同一人在别的空间的安排同样不能撞
    let busySpaceIds = spaceIds;
    if (occupantIds.length > 0) {
      const { data: sm } = await admin
        .from("space_members")
        .select("space_id")
        .in("user_id", occupantIds);
      busySpaceIds = [
        ...new Set([
          ...spaceIds,
          ...((sm ?? []) as Array<{ space_id: string }>).map((r) => r.space_id),
        ]),
      ];
    }

    const { data: busyRows } = await admin
      .from("todos")
      .select(TODO_SELECT)
      .in("space_id", busySpaceIds)
      .neq("status", "done")
      .not("start_at", "is", null);

    const allScheduled = (busyRows ?? []) as unknown as OccupancyTodo[];
    const busy = buildBusy(
      allScheduled.filter((t) => !candidates.some((c) => c.id === t.id)),
    );

    // AI 只负责「排序 + 给缺时长的任务估时长」，时间交给 findFreeSlot 确定性排。
    // busy 不再传给 AI（省 token，也避免它算的时间被覆盖）。
    const candidateForAi = [...candidates].sort(
      (a, b) => computeSortScore(b) - computeSortScore(a),
    );

    const parsed = await chatJson<{
      order: Array<{
        todo_id: string;
        estimated_minutes?: number;
        reason?: string;
      }>;
    }>({
      system: `你是日程排期助手。根据未排期待办，给出它们的执行顺序；对没有时长的任务，估一个合理时长。
时间不用你算——系统会按你给的顺序、用每条任务的时长，自动排进最早的空闲工作时段，绝不重叠。
只输出 JSON：
{
  "order": [
    { "todo_id": "uuid", "estimated_minutes": 60, "reason": "原因" }
  ]
}
规则：
- 优先高优先级、临近 due_at；理解用户 request 里的偏好
- estimated_minutes 只在任务没有 duration_minutes 时才需要给（正数，单位分钟）
- reason 简短说明为什么排这个顺序，可不填
- todo_id 必须来自输入列表，每条最多出现一次`,
      user: JSON.stringify({
        request: body.text || "帮我安排未完成/未排期的任务",
        unscheduled: candidateForAi.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          due_at: t.due_at,
          duration_minutes: t.duration_minutes ?? null,
          assignees: occupantsOf(t).map(
            (uid) => memberMap.get(uid)?.display_name ?? uid,
          ),
        })),
      }),
    });

    // AI 返回的排序结果 → 映射；漏掉的任务按 computeSortScore 兜底补在后面
    const aiByTodo = new Map<
      string,
      { estimated_minutes?: number; reason?: string }
    >();
    for (const o of parsed.order || []) {
      if (o?.todo_id && !aiByTodo.has(o.todo_id)) {
        aiByTodo.set(o.todo_id, {
          estimated_minutes: o.estimated_minutes,
          reason: o.reason,
        });
      }
    }

    const orderedIds: string[] = [];
    for (const o of parsed.order || []) {
      if (
        o?.todo_id &&
        candidates.some((c) => c.id === o.todo_id) &&
        !orderedIds.includes(o.todo_id)
      ) {
        orderedIds.push(o.todo_id);
      }
    }
    for (const t of candidateForAi) {
      if (!orderedIds.includes(t.id)) orderedIds.push(t.id);
    }

    const accepted: BusyEntry[] = [];
    const suggestions: Suggestion[] = [];
    const skipped: Array<{ todo_id: string; title: string; reason: string }> =
      [];

    for (const id of orderedIds) {
      const todo = candidates.find((t) => t.id === id)!;
      const owners = occupantsOf(todo);
      if (owners.length === 0) {
        skipped.push({
          todo_id: todo.id,
          title: todo.title,
          reason: "任务没有指派人和创建人，无法判断时间冲突",
        });
        continue;
      }

      // 时长：已有 duration_minutes 优先 → AI 估 → 兜底 1 小时
      let durationMs: number;
      const dm = todo.duration_minutes;
      const aiEst = aiByTodo.get(todo.id)?.estimated_minutes;
      if (typeof dm === "number" && Number.isFinite(dm) && dm > 0) {
        durationMs = dm * 60 * 1000;
      } else if (
        typeof aiEst === "number" &&
        Number.isFinite(aiEst) &&
        aiEst > 0
      ) {
        durationMs = aiEst * 60 * 1000;
      } else {
        durationMs = 60 * 60 * 1000;
      }

      const pool = [...busy, ...accepted];
      const slot = findFreeSlot({
        busy: pool,
        userIds: owners,
        durationMs,
        from: Date.now(),
        workdayStart: body.workday_start,
        workdayEnd: body.workday_end,
        timezone: body.timezone,
        ignoreTodoIds: new Set([todo.id]),
      });

      if (!slot) {
        skipped.push({
          todo_id: todo.id,
          title: todo.title,
          reason: `未来 14 天工作时段内找不到 ${Math.round(
            durationMs / 60000,
          )} 分钟空闲`,
        });
        continue;
      }

      for (const uid of owners) {
        accepted.push({
          start: slot.start,
          end: slot.end,
          todo_id: todo.id,
          title: todo.title,
          user_id: uid,
        });
      }

      suggestions.push({
        todo_id: todo.id,
        title: todo.title,
        start_at: new Date(slot.start).toISOString(),
        end_at: new Date(slot.end).toISOString(),
        reason: aiByTodo.get(todo.id)?.reason || "",
      });
    }

    const summary = suggestions.length
      ? `预览 ${suggestions.length} 条排期建议，均与已有安排不冲突${
          skipped.length ? `，${skipped.length} 条无法安排` : ""
        }`
      : "没有生成可用的排期建议";

    if (!body.confirm) {
      res.json({
        preview: true,
        suggestions,
        skipped,
        message: summary,
      });
      return;
    }

    const applied: string[] = [];
    for (const s of suggestions) {
      const todo = candidates.find((t) => t.id === s.todo_id);
      if (!todo) continue;

      const owners = occupantsOf(todo);
      let blocked = "";
      for (const uid of owners) {
        const dbConflicts = await checkConflicts({
          admin,
          spaceId: todo.space_id as string,
          userId: uid,
          startAt: s.start_at,
          endAt: s.end_at,
          excludeTodoId: s.todo_id,
        });
        if (dbConflicts.length > 0) {
          blocked = `与「${dbConflicts[0].title}」重叠`;
          break;
        }
      }
      if (blocked) {
        skipped.push({ todo_id: s.todo_id, title: s.title, reason: blocked });
        continue;
      }

      const { error: upErr } = await admin
        .from("todos")
        .update({
          start_at: s.start_at,
          end_at: s.end_at,
          is_all_day: false,
        })
        .eq("id", s.todo_id)
        .eq("space_id", todo.space_id);
      if (upErr) throw new Error(upErr.message);
      applied.push(s.todo_id);
    }

    await admin.from("ai_actions").insert({
      space_id: spaceIds[0],
      user_id: auth.user.id,
      action_type: "reschedule",
      payload: {
        suggestions,
        skipped,
        all_spaces: body.all_spaces,
        include_unscheduled: body.include_unscheduled,
        todo_ids: explicitIds,
      },
      result_todo_ids: applied,
      status: "applied",
    });

    res.json({
      preview: false,
      applied,
      skipped,
      suggestions,
      message: skipped.length
        ? `已写入 ${applied.length} 条排期，${skipped.length} 条因冲突或无法安排被跳过`
        : `已写入 ${applied.length} 条排期`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});
