import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { chatJson } from "../lib/deepseek";
import { getFeishuDocRawContent } from "../lib/feishu";
import { assertSpaceMember } from "../lib/space";
import { createAdminClient } from "../lib/supabase";
import { insertTodosWithAssignees, type TodoPreview } from "../services/todos";
import { fetchWebPage } from "../lib/web-fetch";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";

/**
 * 知识板块：连接知识源（网页/飞书）→ DeepSeek 拆解问题 → 生成可执行方案。
 * 先方案后执行：decompose 落库 pending，用户确认后 confirm 转 confirmed，
 * 再 apply 把步骤转成待办（补闭环）→ applied。
 * 挂载于 /ai 下：/ai/knowledge/sources、/ai/knowledge/decompose、/ai/knowledge/confirm、/ai/knowledge/apply。
 */

type PlanStep = {
  no: number;
  title: string;
  action: string;
  depends_on: number[];
  expected: string;
};

type PlanPayload = {
  summary?: string;
  steps?: PlanStep[];
};

const addSourceSchema = z.object({
  space_id: z.string().uuid(),
  type: z.enum(["web", "feishu"]),
  url: z.string().min(1),
  title: z.string().optional(),
});

const decomposeSchema = z.object({
  space_id: z.string().uuid(),
  question: z.string().min(1),
  source_ids: z.array(z.string().uuid()).optional(),
});

const confirmSchema = z.object({
  space_id: z.string().uuid(),
  plan_id: z.string().uuid(),
});

const applySchema = z.object({
  space_id: z.string().uuid(),
  plan_id: z.string().uuid(),
});

const SOURCE_META_SELECT =
  "id, space_id, user_id, type, title, url, status, error, created_at";

// 每个知识源给 AI 的正文上限（字符），控制上下文体积
const CONTEXT_CHUNK_LIMIT = 3000;

export const knowledgeRouter = Router();

// 1) 添加知识源：web 抓网页正文，feishu 读云文档正文，全量落库
knowledgeRouter.post("/knowledge/sources", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = addSourceSchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    let title = body.title;
    let content: string;

    if (body.type === "web") {
      const page = await fetchWebPage(body.url);
      title = title || page.title;
      content = page.content;
    } else {
      const doc = await getFeishuDocRawContent({
        appId: config.feishuAppId,
        appSecret: config.feishuAppSecret,
        docUrl: body.url,
      });
      title = title || doc.title || doc.document_id;
      content = doc.content;
    }

    if (!content.trim()) {
      throw new Error("抓取到的正文为空，无法作为知识源");
    }

    const { data, error } = await admin
      .from("knowledge_sources")
      .insert({
        space_id: body.space_id,
        user_id: auth.user.id,
        type: body.type,
        title: title || body.url,
        url: body.url,
        content,
        status: "ready",
      })
      .select(SOURCE_META_SELECT)
      .single();

    if (error) throw new Error(error.message);

    res.json({ source: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 2) 列出知识源（不含正文，正文只在拆解时读取）
knowledgeRouter.get("/knowledge/sources", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const spaceId = String(req.query.space_id || "");
    if (!spaceId) {
      res.status(400).json({ error: "需要 space_id" });
      return;
    }

    const admin = createAdminClient();
    await assertSpaceMember(admin, spaceId, auth.user.id);

    const { data, error } = await admin
      .from("knowledge_sources")
      .select(SOURCE_META_SELECT)
      .eq("space_id", spaceId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    res.json({ sources: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 3) 拆解问题：检索知识源正文 → DeepSeek 生成步骤化方案 → 落库 pending
knowledgeRouter.post("/knowledge/decompose", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = decomposeSchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    let query = admin
      .from("knowledge_sources")
      .select("id, title, content, type")
      .eq("space_id", body.space_id)
      .eq("status", "ready");
    if (body.source_ids?.length) {
      query = query.in("id", body.source_ids);
    }
    const { data: sources, error } = await query;
    if (error) throw new Error(error.message);

    const context = (sources ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      content: (s.content || "").slice(0, CONTEXT_CHUNK_LIMIT),
    }));

    const parsed = await chatJson<PlanPayload>({
      system: `你是问题拆解助手。根据提供的知识源内容，把用户的问题拆解成可逐步执行的行动方案。
只输出 JSON（不要输出其它文字）：
{
  "summary": "一句话概述整体方案",
  "steps": [
    { "no": 1, "title": "步骤标题", "action": "具体要做什么（明确的动作）", "depends_on": [], "expected": "做完后的预期结果" }
  ]
}
规则：
- 步骤要具体、可落地，每条的 action 都是可直接执行的明确动作
- depends_on 用步骤编号表示前置依赖，无依赖填 []
- 步骤数控制在 3~8 条
- 优先利用知识源内容；若知识源为空或与问题无关，也基于常识给出通用方案`,
      user: JSON.stringify({
        question: body.question,
        knowledge: context,
      }),
    });

    const steps: PlanStep[] = (parsed.steps || [])
      .filter((s) => s && s.title && s.action)
      .map((s, i) => ({
        no: typeof s.no === "number" ? s.no : i + 1,
        title: s.title,
        action: s.action,
        depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
        expected: s.expected || "",
      }));

    if (steps.length === 0) {
      throw new Error("AI 未能拆解出有效步骤");
    }

    const summary = parsed.summary || "未提供概述";
    const planJson = { summary, steps };
    const usedSources = context.map((c) => ({ id: c.id, title: c.title }));

    const { data: plan, error: insErr } = await admin
      .from("knowledge_plans")
      .insert({
        space_id: body.space_id,
        user_id: auth.user.id,
        question: body.question,
        summary,
        plan_json: planJson,
        sources: usedSources,
        status: "pending",
      })
      .select()
      .single();

    if (insErr) throw new Error(insErr.message);

    res.json({ preview: true, plan });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 4) 确认方案：pending → confirmed（P2 再扩展为逐条自动执行）
knowledgeRouter.post("/knowledge/confirm", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = confirmSchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    const { data, error } = await admin
      .from("knowledge_plans")
      .update({ status: "confirmed" })
      .eq("id", body.plan_id)
      .eq("space_id", body.space_id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) throw new Error("方案不存在");

    res.json({ confirmed: true, plan: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 5) 应用方案：confirmed 方案的步骤 → 生成待办 → plan 转 applied（补闭环）
knowledgeRouter.post("/knowledge/apply", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = applySchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    const { data: plan, error } = await admin
      .from("knowledge_plans")
      .select("id, plan_json, status")
      .eq("id", body.plan_id)
      .eq("space_id", body.space_id)
      .single();

    if (error) throw new Error(error.message);
    if (!plan) throw new Error("方案不存在");
    if (plan.status === "applied") throw new Error("该方案已生成过待办，请勿重复执行");
    if (plan.status !== "confirmed") throw new Error("请先确认方案，再生成待办");

    const steps: PlanStep[] = Array.isArray(plan.plan_json?.steps)
      ? plan.plan_json.steps
      : [];
    const validSteps = steps.filter((s) => s && s.title && s.action);
    if (validSteps.length === 0) throw new Error("方案没有可执行的步骤");

    // 依赖编号 → 步骤标题映射，用于把 depends_on 转成可读的前置说明
    const titleByNo = new Map<number, string>();
    for (const s of steps) {
      if (typeof s.no === "number") titleByNo.set(s.no, s.title);
    }

    const items: TodoPreview[] = validSteps.map((s) => {
      const parts: string[] = [s.action];
      if (s.expected?.trim()) parts.push(`预期：${s.expected.trim()}`);
      const deps = (Array.isArray(s.depends_on) ? s.depends_on : [])
        .map((n) => titleByNo.get(n))
        .filter((t): t is string => Boolean(t));
      if (deps.length) parts.push(`前置：${deps.join("、")}`);

      return {
        title: String(s.title).slice(0, 255),
        description: parts.join("\n\n"),
        priority: "medium",
        assignee_ids: [auth.user.id],
        start_at: null,
        end_at: null,
        due_at: null,
        is_all_day: false,
      };
    });

    const todoIds = await insertTodosWithAssignees({
      admin,
      spaceId: body.space_id,
      creatorId: auth.user.id,
      conversationId: null,
      items,
    });

    const { error: updErr } = await admin
      .from("knowledge_plans")
      .update({ status: "applied" })
      .eq("id", body.plan_id)
      .eq("space_id", body.space_id);
    if (updErr) throw new Error(updErr.message);

    res.json({ applied: true, plan_id: body.plan_id, todo_ids: todoIds, todos: items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});
