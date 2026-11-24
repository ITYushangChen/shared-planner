import fs from "fs";
import path from "path";
import { Router } from "express";
import { z } from "zod";
import { chatJson } from "../lib/deepseek";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";

const bodySchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().min(1),
        status: z.enum(["done", "in_progress", "todo"]).optional(),
        category: z.string().optional(),
        /** 以下为可选的客观依据，用于把描述写具体；缺失时不臆测 */
        space_name: z.string().optional(),
        time_label: z.string().optional(),
        date_iso: z.string().nullish(),
        priority: z.string().optional(),
        description: z.string().nullish(),
        assignees: z.array(z.string()).optional(),
        /** 协作评价 / 评论：成员在任务下的沟通记录、进展或反馈，作为补充依据；缺失时不臆测 */
        comments: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(50),
});

/** 读取任务名称改写规则（renwumingcheng 文件）；缺失时使用兜底规则 */
function loadTaskNameRules(): string {
  try {
    const file = path.join(process.cwd(), "renwumingcheng");
    const content = fs.readFileSync(file, "utf8").trim();
    if (content) return content;
  } catch {
    // 文件缺失时忽略，走兜底规则
  }
  return [
    "你负责把一条任务整理成周报 / 月报里的“任务说明”，要写得严谨、清楚、可信。",
    "综合以下信息来写：",
    "  · 任务名称（必填）：任务的核心内容，要在说明里体现；",
    "  · 任务描述（可选）：对任务的进一步说明，优先采信；",
    "  · 协作评价 / 评论（可选）：成员在任务下留下的沟通记录、进展或反馈，提炼要点作为补充，但不要原样照抄；",
    "  · 空间、时间、负责人（可选）：用于在末尾补一句客观说明，没有就不写、不臆测。",
    "写作要求：",
    "1) 书面、客观、平实，只陈述事实和结果，不用口语、网络用语和夸张说法；",
    "2) 尽量少用专业术语和内部代号（如 BUG / FEAT / 接口 / 联调 等）；确需提及某项功能或模块时，用大家能看懂的说法；",
    "3) 写清“做了什么、做到什么程度、结果或作用”；信息不足以判断程度时，只写做了什么，不编造进度；",
    "4) 只写输入中可确认的事实，不编造时间、数据、人名；评价里若含情绪化或无关内容可忽略；",
    "5) 每条控制在 40～100 字；",
    "6) 只输出 JSON。",
  ].join("\n");
}

export const aiReportPlainRouter = Router();

/** 按 renwumingcheng 规则，把任务名称改写成严谨、具体、术语克制的任务描述 */
aiReportPlainRouter.post("/report-plain", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = bodySchema.parse(req.body || {});

    const parsed = await chatJson<{
      items?: Array<{ id: string; text: string }>;
    }>({
      system: `你是企业日报 / 周报 / 月报的撰写助手。请综合每条任务的【名称、描述、协作评价】来撰写任务说明，语言严谨、客观，少用专业术语。\n\n${loadTaskNameRules()}`,
      user: JSON.stringify({
        user_id: auth.user.id,
        tasks: body.tasks,
      }),
      temperature: 0.4,
    });

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    res.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});
