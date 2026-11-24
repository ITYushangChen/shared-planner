import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { chatJson } from "../lib/deepseek";
import { getFeishuDocRawContent } from "../lib/feishu";
import { buildBusy, type OccupancyTodo } from "../lib/occupancy";
import {
  addDays,
  countStudyDays,
  packStudyPlan,
  todayInTz,
} from "../lib/study-packing";
import { assertSpaceMember, listUserSpaceIds } from "../lib/space";
import { createAdminClient } from "../lib/supabase";
import { insertTodosWithAssignees, type TodoPreview } from "../services/todos";
import {
  chaptersToUnits,
  clampMinPerPage,
  difficultyFactor,
  groupSlotsByDate as groupByDate,
  normalizeChapters,
  normalizeDifficulty,
  unitTodoDescription,
  unitTodoTitle,
  type OutlineChapter,
} from "../services/study";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";

/**
 * 学习计划板块：书本目录 → 学习单元 → 自动排程 → 待办
 *
 * 分工（关键）：
 *   ① AI 只做「把目录切成章节 + 给每章估分钟数」（outline）
 *   ② 「这些单元铺到哪几天几点」由 lib/study-packing 的确定性算法完成（plan）
 * 这样计划可复现、可解释；用户改参数重排是纯计算，不产生 AI 调用。
 *
 * 挂载于 /ai 下：
 *   POST /ai/study/outline  解析目录（飞书 / 粘贴文本 / 只给书名）
 *   POST /ai/study/plan     切单元 + 装箱 → 计划预览（落库 planned）
 *   POST /ai/study/apply    确认 → 写待办（planned → applied）
 *   GET  /ai/study/plans    计划列表 + 进度
 *   GET  /ai/study/plans/:id 计划详情（含每个学习块）
 *   DELETE /ai/study/plans/:id 删除计划（?with_todos=1 连带删生成的待办）
 */

const TODO_SELECT =
  "id, space_id, title, priority, status, start_at, end_at, due_at, is_all_day, creator_id, todo_assignees(user_id)";

const OUTLINE_TEXT_LIMIT = 8000;
const MAX_OUTLINE_ITEMS = 60;

const chapterSchema = z.object({
  no: z.number().int().optional().nullable(),
  title: z.string().min(1),
  level: z.number().int().optional().nullable(),
  parent_no: z.number().int().optional().nullable(),
  /** 旧口径：AI 直接给的分钟数。仅在没给 pages 时作兜底 */
  minutes: z.number().optional().nullable(),
  /** 可校准量：这一项在书上大约多少页 */
  pages: z.number().optional().nullable(),
  /** 可校准量：1=概念/记忆  2=普通  3=证明/计算密集 */
  difficulty: z.number().optional().nullable(),
});

const outlineSchema = z
  .object({
    space_id: z.string().uuid(),
    source: z.enum(["feishu", "text", "book"]),
    url: z.string().optional(),
    text: z.string().optional(),
    book_title: z.string().optional(),
    author: z.string().optional(),
    subject: z.string().optional(),
    /** 解析后立即按此速度折算分钟（前端默认 5，可调） */
    min_per_page: z.number().optional().nullable(),
  })
  .refine(
    (d) =>
      (d.source === "feishu" && d.url) ||
      (d.source === "text" && d.text) ||
      (d.source === "book" && d.book_title),
    { message: "缺少对应来源的输入（feishu 需要 url / text 需要 text / book 需要 book_title）" },
  );

const planSchema = z.object({
  space_id: z.string().uuid(),
  book_title: z.string().min(1),
  chapters: z.array(chapterSchema).min(1),
  source_type: z.enum(["feishu", "text", "book"]).optional().default("text"),
  source_url: z.string().optional().nullable(),
  outline_meta: z.record(z.any()).optional(),
  daily_start: z.string().optional().default("20:00"),
  daily_end: z.string().optional().default("21:30"),
  daily_minutes_cap: z.number().int().positive().optional().nullable(),
  weekdays: z
    .array(z.number().int().min(1).max(7))
    .optional()
    .default([1, 2, 3, 4, 5]),
  start_date: z.string().optional(),
  deadline: z.string().optional().nullable(),
  unit_minutes: z.number().int().min(15).max(180).optional().default(45),
  /** 每页分钟（用户可校准的唯一旋钮）；minutes 由 pages×min_per_page×难度系数 算出 */
  min_per_page: z.number().optional().nullable(),
  timezone: z.string().optional().default("Asia/Shanghai"),
});

const applySchema = z.object({
  space_id: z.string().uuid(),
  plan_id: z.string().uuid(),
});

export const studyRouter = Router();

function statusFor(message: string): number {
  if (message.includes("Not a member")) return 403;
  if (message.includes("不存在")) return 404;
  return 400;
}

function fail(res: import("express").Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(statusFor(message)).json({ error: message });
}

/* -------------------------------------------------------------------------- */
/* 目录来源：只给书名时尝试联网抓真实目录                                       */
/* -------------------------------------------------------------------------- */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * 按「开标签匹配的 id」切出一个 div 的完整内容（含嵌套 div 也正确配对闭合）。
 * 豆瓣目录区块的 id 是动态的（dir_<subjectId>_full / _short / 旧版 _all），
 * 所以只按属性正则定位开标签，再自己扫 `</div>` 找闭合。
 */
function sliceDivById(html: string, openTagPattern: RegExp): string {
  const open = openTagPattern.exec(html);
  if (!open) return "";
  const tagEnd = html.indexOf(">", open.index);
  if (tagEnd === -1) return "";

  let depth = 1;
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = tagEnd + 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      depth -= 1;
      if (depth === 0) return html.slice(tagEnd + 1, m.index);
    } else {
      depth += 1;
    }
  }
  return html.slice(tagEnd + 1);
}

/**
 * 从豆瓣图书详情页里抠出目录。
 * 真实 DOM（2026-11 实测）：
 *   <div class="indent" id="dir_1105582_short">…（折叠，只给章）</div>
 *   <div class="indent" id="dir_1105582_full" style="display:none">…（全量）</div>
 * 优先 full，其次 short，最后兼容旧版 _all。
 */
function extractDoubanOutline(html: string): string[] {
  const block =
    sliceDivById(html, /<div[^>]*\bid="dir_\d+_full"/i) ||
    sliceDivById(html, /<div[^>]*\bid="dir_\d+_short"/i) ||
    sliceDivById(html, /<div[^>]*\bid="dir_\d+_all"/i);
  if (!block) return [];

  return block
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (line.length < 2 || line.length > 120) return false;
      // 占位行「· · · · · ·」、纯符号行、折叠锚点残留
      if (/^[·•.。…\s\-—_]+$/.test(line)) return false;
      if (/^(收起|展开|目录)$/.test(line)) return false;
      if (/javascript:/i.test(line)) return false;
      return true;
    });
}

/**
 * best-effort：豆瓣搜书名 → 拿第一个条目 → 抓目录。
 * 抓不到（反爬 / 超时 / 页面改版）就返回空，由调用方降级到 AI 生成。
 */
async function tryFetchBookOutline(
  bookTitle: string,
  author?: string,
): Promise<{ lines: string[]; url: string; detailTitle: string } | null> {
  const q = [bookTitle, author].filter(Boolean).join(" ").trim();
  if (!q) return null;

  const searchHtml = await fetchHtml(
    `https://book.douban.com/subject_search?search_text=${encodeURIComponent(
      q,
    )}&cat=1001`,
    8000,
  );
  const subjectId = /book\.douban\.com\/subject\/(\d+)/.exec(searchHtml)?.[1];
  if (!subjectId) return null;

  const detailUrl = `https://book.douban.com/subject/${subjectId}/`;
  const detailHtml = await fetchHtml(detailUrl, 8000);
  if (!detailHtml) return null;

  const lines = extractDoubanOutline(detailHtml);
  if (lines.length < 3) return null;

  const detailTitle =
    /<title>\s*([^<]+)<\/title>/i
      .exec(detailHtml)?.[1]
      ?.replace(/\s*\(豆瓣\)\s*$/, "")
      .trim() || bookTitle;

  return { lines, url: detailUrl, detailTitle };
}

/* -------------------------------------------------------------------------- */
/* AI：目录文本 → 章节列表                                                     */
/* -------------------------------------------------------------------------- */

type OutlineAiResult = {
  book_title?: string;
  chapters?: OutlineChapter[];
};

async function parseOutlineFromText(params: {
  bookTitle: string;
  text: string;
}): Promise<OutlineAiResult> {
  const text = params.text.slice(0, OUTLINE_TEXT_LIMIT);
  return chatJson<OutlineAiResult>({
    system: `你是教材目录解析助手。用户给你一段教材目录文本，你要把它解析成结构化章节列表，并为每一项估出「多少页」和「难度」。

只输出 JSON（不要输出任何其它文字）：
{
  "book_title": "书名（原文里能看到就填，看不到就原样返回用户给的书名）",
  "chapters": [
    { "no": 1, "title": "第1章 基础：逻辑和证明", "level": 1, "parent_no": null, "pages": 42, "difficulty": 3 },
    { "no": 2, "title": "1.1 命题逻辑", "level": 2, "parent_no": 1, "pages": 14, "difficulty": 2 }
  ]
}

规则：
- no 从 1 开始连续编号，全书唯一
- level：1=章/篇，2=节，3=更深层级
- parent_no：该节点的父节点 no；顶层填 null
- **pages：这一项在标准中文版教材里大约占多少页（整数）**，只算正文页，不含章末习题册
  参考：单节通常 6~20 页；普通一章 25~60 页；厚书大章（如数据结构「图」）60~100 页
- **difficulty：1=概念/定义/记忆为主（如绪论、术语表）；2=普通（有推导但套路固定）；3=证明/计算密集，必须动笔（如数理逻辑证明、算法设计、计数问题）**
- **不要输出 minutes，时长由系统按页数和难度换算**
- **最多输出 ${MAX_OUTLINE_ITEMS} 项**。目录项超过 ${MAX_OUTLINE_ITEMS} 时，只保留到「章」级（level=1），丢弃节
- 原文的编号和标题必须原样保留，不要改写、不要编造原文没有的项
- **跳过非学习内容**：前言/序/致谢/参考文献/索引/习题答案/版权页/封底推荐，以及英文目录里的
  preface、acknowledgements、index、answers to …、exercises（独立的习题区块）、
  key terms、review questions、credits（这些页数已含在所属章节里，单列会重复计时）
- 如果这段文本明显不是目录（是正文、乱码、广告），chapters 返回空数组 []`,
    user: JSON.stringify({
      book_title: params.bookTitle,
      table_of_contents: text,
    }),
    temperature: 0.1,
  });
}

/** 只给书名、且联网没抓到目录时的降级：AI 凭知识生成草案，标记为低可信 */
async function generateOutlineFromBook(params: {
  bookTitle: string;
  author?: string;
  subject?: string;
}): Promise<OutlineAiResult & { confidence: "high" | "low" }> {
  const res = await chatJson<OutlineAiResult & { confidence?: string }>({
    system: `你是教材目录专家。用户只给了书名，你要给出这本书真实的章节目录，并估每章页数与难度。

只输出 JSON：
{
  "book_title": "完整书名（含版次，如：离散数学及其应用（第7版））",
  "confidence": "high 或 low",
  "chapters": [
    { "no": 1, "title": "第1章 基础：逻辑和证明", "level": 1, "parent_no": null, "pages": 42, "difficulty": 3 }
  ]
}

规则：
- 只输出你高度确信真实存在的章节；不确定就少输出，宁可只给章级也可以
- **最多 ${MAX_OUTLINE_ITEMS} 项，优先只到「章」级**
- title 用该书通行中文版的章节名（含章节号）
- **pages：该章在通行中文版里大约多少页（整数），普通章 25~60，厚书大章 60~100**
- **difficulty：1=概念记忆为主  2=普通  3=证明/计算密集必须动笔**
- **不要输出 minutes**
- confidence：对这本书目录真实性有把握填 "high"，靠推断填 "low"
- 完全想不起这本书的结构时，chapters 返回 []，不要硬编`,
    user: JSON.stringify({
      book_title: params.bookTitle,
      author: params.author || "",
      subject: params.subject || "",
    }),
    temperature: 0.1,
  });

  return {
    ...res,
    confidence: res.confidence === "high" ? "high" : "low",
  };
}

/* -------------------------------------------------------------------------- */
/* 1) 目录解析                                                                 */
/* -------------------------------------------------------------------------- */

studyRouter.post("/study/outline", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = outlineSchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    let rawText = "";
    let bookTitle = body.book_title?.trim() || "";
    let sourceUrl: string | null = null;
    let note = "";
    let aiGenerated = false;
    let confidence: "high" | "low" = "high";

    if (body.source === "feishu") {
      const doc = await getFeishuDocRawContent({
        appId: config.feishuAppId,
        appSecret: config.feishuAppSecret,
        docUrl: body.url!,
      });
      rawText = doc.content || "";
      bookTitle = bookTitle || doc.title || "";
      sourceUrl = body.url!;
      if (!rawText.trim()) throw new Error("飞书文档正文为空，请确认文档里有目录内容");
    } else if (body.source === "text") {
      rawText = body.text || "";
      if (rawText.trim().length < 10) {
        throw new Error("目录文本太短，至少需要包含几个章节标题");
      }
    } else {
      // 只给书名：先试联网抓真实目录，抓不到再让 AI 生成草案
      const web = await tryFetchBookOutline(bookTitle, body.author);
      if (web) {
        rawText = web.lines.join("\n");
        sourceUrl = web.url;
        bookTitle = bookTitle || web.detailTitle;
        note = `目录抓取自豆瓣《${web.detailTitle}》（${web.lines.length} 行）`;
      } else {
        aiGenerated = true;
        confidence = "low";
        note = "联网未获取到该书的目录，以下为 AI 生成的草案，请核对后再排期";
      }
    }

    let result: OutlineAiResult;
    if (rawText.trim()) {
      result = await parseOutlineFromText({ bookTitle, text: rawText });
    } else if (aiGenerated) {
      result = await generateOutlineFromBook({
        bookTitle,
        author: body.author,
        subject: body.subject,
      });
      // AI 草案一律标 low：没有真实目录可核对，采纳 AI 自评的 "high" 会误导用户
      // （实测 AI 对知名教材会自评 high，但目录是凭记忆编的）
      confidence = "low";
    } else {
      throw new Error("没有可解析的目录内容");
    }

    const chapters = normalizeChapters(
      (result.chapters ?? []) as OutlineChapter[],
      45,
      clampMinPerPage(body.min_per_page),
    );

    if (chapters.length === 0) {
      throw new Error(
        aiGenerated
          ? "AI 无法确定这本书的目录，请改用「粘贴目录」或「飞书文档链接」"
          : "没能从这段文本里解析出章节，请检查内容是否为目录",
      );
    }

    res.json({
      book_title: result.book_title?.trim() || bookTitle || "未命名教材",
      chapters,
      source: aiGenerated ? "ai" : body.source,
      source_url: sourceUrl,
      confidence,
      needs_review: aiGenerated || confidence === "low",
      note,
      stats: {
        chapter_count: chapters.length,
        total_minutes: chapters.reduce((s, c) => s + c.minutes, 0),
        total_pages: chapters.reduce((s, c) => s + (c.pages ?? 0), 0),
        min_per_page: clampMinPerPage(body.min_per_page),
        pages_known: chapters.filter((c) => c.pages !== null).length,
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

/* -------------------------------------------------------------------------- */
/* 2) 排期预览（落库 planned）                                                 */
/* -------------------------------------------------------------------------- */

studyRouter.post("/study/plan", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = planSchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    // 分钟数由 pages×min_page×难度 在后端重算一次：前端改了页数/难度/每页分钟都以这里为准
    const minPerPage = clampMinPerPage(body.min_per_page);
    const chapters = normalizeChapters(
      body.chapters as OutlineChapter[],
      body.unit_minutes,
      minPerPage,
    );
    if (chapters.length === 0) throw new Error("目录为空，无法排期");

    const units = chaptersToUnits(chapters, body.unit_minutes);
    if (units.length === 0) throw new Error("目录切不出有效的学习单元");

    // 已有日程：跨该用户所有空间取，避免和别人共享空间里的安排撞车
    const spaceIds = await listUserSpaceIds(admin, auth.user.id);
    const busySpaceIds = spaceIds.length > 0 ? spaceIds : [body.space_id];
    const { data: busyRows, error: busyErr } = await admin
      .from("todos")
      .select(TODO_SELECT)
      .in("space_id", busySpaceIds)
      .neq("status", "done")
      .not("start_at", "is", null);
    if (busyErr) throw new Error(busyErr.message);

    const busy = buildBusy((busyRows ?? []) as unknown as OccupancyTodo[]);

    const startDate = body.start_date?.trim() || todayInTz(body.timezone);

    const packed = packStudyPlan({
      units,
      startDate,
      weekdays: body.weekdays,
      dailyStart: body.daily_start,
      dailyEnd: body.daily_end,
      dailyMinutesCap: body.daily_minutes_cap ?? null,
      timezone: body.timezone,
      busy,
      userIds: [auth.user.id],
      deadline: body.deadline || null,
    });

    const params = {
      daily_start: body.daily_start,
      daily_end: body.daily_end,
      daily_minutes_cap: body.daily_minutes_cap ?? null,
      weekdays: body.weekdays,
      start_date: startDate,
      deadline: body.deadline || null,
      unit_minutes: body.unit_minutes,
      min_per_page: minPerPage,
      timezone: body.timezone,
    };

    const summary = {
      total_minutes: packed.total_minutes,
      placed_minutes: packed.placed_minutes,
      total_units: packed.total_units,
      placed_units: packed.placed_units,
      days_needed: packed.days_needed,
      start_date: packed.start_date,
      end_date: packed.end_date,
      daily_avg_minutes: packed.daily_avg_minutes,
      deadline_fit: packed.deadline_fit,
      warnings: packed.warnings,
      min_per_page: minPerPage,
      total_pages: chapters.reduce((s, c) => s + (c.pages ?? 0), 0),
    };

    const { data: plan, error: planErr } = await admin
      .from("study_plans")
      .insert({
        space_id: body.space_id,
        user_id: auth.user.id,
        book_title: body.book_title.slice(0, 200),
        source_type: body.source_type,
        source_url: body.source_url ?? null,
        outline: chapters,
        outline_meta: body.outline_meta ?? {},
        params,
        summary,
        status: "planned",
      })
      .select()
      .single();
    if (planErr || !plan) throw new Error(planErr?.message || "创建学习计划失败");

    const rows = [
      ...packed.slots.map((s) => ({
        plan_id: plan.id,
        space_id: body.space_id,
        seq: s.seq,
        title: s.title,
        chapter_no: s.chapter_no,
        minutes: s.minutes,
        pages: s.pages ?? null,
        difficulty: s.difficulty ?? null,
        scheduled_start: new Date(s.start_ms).toISOString(),
        scheduled_end: new Date(s.end_ms).toISOString(),
      })),
      ...packed.unplaced.map((u) => ({
        plan_id: plan.id,
        space_id: body.space_id,
        seq: u.seq,
        title: u.title,
        chapter_no: u.chapter_no,
        minutes: u.minutes,
        pages: u.pages ?? null,
        difficulty: u.difficulty ?? null,
        scheduled_start: null,
        scheduled_end: null,
      })),
    ].sort((a, b) => a.seq - b.seq);

    if (rows.length > 0) {
      const { error: itemErr } = await admin
        .from("study_plan_items")
        .insert(rows);
      if (itemErr) throw new Error(itemErr.message);
    }

    res.json({
      preview: true,
      plan: {
        id: plan.id,
        book_title: plan.book_title,
        status: plan.status,
        params,
        summary,
      },
      days: groupByDate(
        packed.slots.map((s) => ({
          date: s.date,
          minutes: s.minutes,
          seq: s.seq,
          title: s.title,
          pages: s.pages ?? null,
          difficulty: s.difficulty ?? null,
          start_at: new Date(s.start_ms).toISOString(),
          end_at: new Date(s.end_ms).toISOString(),
        })),
      ),
      unplaced: packed.unplaced,
      warnings: packed.warnings,
    });
  } catch (err) {
    fail(res, err);
  }
});

/* -------------------------------------------------------------------------- */
/* 3) 确认 → 写待办                                                            */
/* -------------------------------------------------------------------------- */

studyRouter.post("/study/apply", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = applySchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    const { data: plan, error } = await admin
      .from("study_plans")
      .select("id, book_title, status, space_id")
      .eq("id", body.plan_id)
      .eq("space_id", body.space_id)
      .single();
    if (error || !plan) throw new Error("学习计划不存在");
    if (plan.status === "applied") {
      throw new Error("这个计划已经生成过待办，请勿重复执行");
    }

    const { data: items, error: itemErr } = await admin
      .from("study_plan_items")
      .select(
        "id, seq, title, chapter_no, minutes, pages, difficulty, scheduled_start, scheduled_end, todo_id",
      )
      .eq("plan_id", body.plan_id)
      .is("todo_id", null)
      .not("scheduled_start", "is", null)
      .order("seq", { ascending: true });
    if (itemErr) throw new Error(itemErr.message);

    const list = items ?? [];
    if (list.length === 0) throw new Error("没有可生成的待办（可能全部已生成或都未排上时间）");

    const total = list.length;
    const todoItems: TodoPreview[] = list.map((it, i) => ({
      title: unitTodoTitle({
        bookTitle: plan.book_title,
        unitTitle: it.title,
      }),
      description: unitTodoDescription({
        bookTitle: plan.book_title,
        chapterNo: it.chapter_no ?? null,
        minutes: it.minutes,
        pages: it.pages ?? null,
        difficulty: it.difficulty ?? null,
        seq: i + 1,
        total,
      }),
      priority: "medium",
      assignee_ids: [auth.user.id],
      start_at: it.scheduled_start,
      end_at: it.scheduled_end,
      due_at: null,
      is_all_day: false,
      duration_minutes: it.minutes,
    }));

    const todoIds = await insertTodosWithAssignees({
      admin,
      spaceId: body.space_id,
      creatorId: auth.user.id,
      conversationId: null,
      items: todoItems,
    });

    // 回填 todo_id：insertTodosWithAssignees 内部按 items 顺序逐条插入，顺序一致
    for (let i = 0; i < list.length; i++) {
      const { error: upErr } = await admin
        .from("study_plan_items")
        .update({ todo_id: todoIds[i] })
        .eq("id", list[i].id);
      if (upErr) throw new Error(upErr.message);
    }

    const { error: planUpdErr } = await admin
      .from("study_plans")
      .update({ status: "applied", updated_at: new Date().toISOString() })
      .eq("id", body.plan_id)
      .eq("space_id", body.space_id);
    if (planUpdErr) throw new Error(planUpdErr.message);

    res.json({
      applied: true,
      plan_id: body.plan_id,
      todo_count: todoIds.length,
      todo_ids: todoIds,
    });
  } catch (err) {
    fail(res, err);
  }
});

/* -------------------------------------------------------------------------- */
/* 4) 计划列表 / 详情                                                          */
/* -------------------------------------------------------------------------- */

studyRouter.get("/study/plans", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const spaceId = String(req.query.space_id || "");
    const admin = createAdminClient();

    // space_id 可选：不传则返回该用户在所有空间的计划（学习计划本质是个人安排）
    let scopeIds: string[];
    if (spaceId) {
      await assertSpaceMember(admin, spaceId, auth.user.id);
      scopeIds = [spaceId];
    } else {
      scopeIds = await listUserSpaceIds(admin, auth.user.id);
      if (scopeIds.length === 0) {
        res.json({ plans: [] });
        return;
      }
    }

    const { data: plans, error } = await admin
      .from("study_plans")
      .select("id, space_id, user_id, book_title, source_type, outline_meta, params, summary, status, created_at")
      .in("space_id", scopeIds)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    const ids = (plans ?? []).map((p) => p.id);
    let progress: Record<string, unknown> = {};
    if (ids.length > 0) {
      const { data: prog } = await admin
        .from("study_plan_progress")
        .select("plan_id, total_units, done_units, total_minutes, done_minutes")
        .in("plan_id", ids);
      progress = Object.fromEntries(
        (prog ?? []).map((r) => [String(r.plan_id), r]),
      );
    }

    res.json({
      plans: (plans ?? []).map((p) => ({
        ...p,
        progress: progress[String(p.id)] ?? {
          total_units: 0,
          done_units: 0,
          total_minutes: 0,
          done_minutes: 0,
        },
      })),
    });
  } catch (err) {
    fail(res, err);
  }
});

studyRouter.get("/study/plans/:id", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const planId = String(req.params.id || "");
    const admin = createAdminClient();

    const { data: plan, error } = await admin
      .from("study_plans")
      .select("*")
      .eq("id", planId)
      .single();
    if (error || !plan) throw new Error("学习计划不存在");
    await assertSpaceMember(admin, plan.space_id as string, auth.user.id);

    const { data: items, error: itemErr } = await admin
      .from("study_plan_items")
      .select(
        "id, seq, title, chapter_no, minutes, pages, difficulty, actual_minutes, scheduled_start, scheduled_end, todo_id, status",
      )
      .eq("plan_id", planId)
      .order("seq", { ascending: true });
    if (itemErr) throw new Error(itemErr.message);

    res.json({
      plan,
      items: items ?? [],
      days: groupByDate(
        (items ?? [])
          .filter((i) => i.scheduled_start)
          .map((i) => ({
            date: String(i.scheduled_start).slice(0, 10),
            minutes: i.minutes,
            id: i.id,
            seq: i.seq,
            title: i.title,
            pages: i.pages ?? null,
            difficulty: i.difficulty ?? null,
            actual_minutes: i.actual_minutes ?? null,
            start_at: i.scheduled_start,
            end_at: i.scheduled_end,
            todo_id: i.todo_id,
            status: i.status,
          })),
      ),
    });
  } catch (err) {
    fail(res, err);
  }
});

/* -------------------------------------------------------------------------- */
/* 校准：记录实际用时 → 反推「我一页到底要几分钟」                              */
/* -------------------------------------------------------------------------- */

const actualSchema = z.object({
  actual_minutes: z.number().int().min(1).max(1440),
});

/** 记录某个学习块的真实用时（用户学完自己填） */
studyRouter.patch("/study/items/:id/actual", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const itemId = String(req.params.id || "");
    const body = actualSchema.parse(req.body);
    const admin = createAdminClient();

    const { data: item, error } = await admin
      .from("study_plan_items")
      .select("id, plan_id, space_id")
      .eq("id", itemId)
      .single();
    if (error || !item) throw new Error("学习单元不存在");
    await assertSpaceMember(admin, item.space_id as string, auth.user.id);

    // 校准只对「自己的计划」有意义：同空间他人的计划不能改
    const { data: plan, error: planErr } = await admin
      .from("study_plans")
      .select("user_id")
      .eq("id", item.plan_id)
      .single();
    if (planErr || !plan) throw new Error("学习计划不存在");
    if (plan.user_id !== auth.user.id) throw new Error("只能校准自己的学习计划");

    const { error: upErr } = await admin
      .from("study_plan_items")
      .update({ actual_minutes: body.actual_minutes })
      .eq("id", itemId);
    if (upErr) throw new Error(upErr.message);

    res.json({ ok: true, id: itemId, actual_minutes: body.actual_minutes });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * 校准报告：用已填的实际用时反推「每页分钟」，并按书分组 + 展示难度系数偏差。
 *
 * 算法：suggested = Σ实际分钟 / Σ(页数 × 难度系数)
 * 按页数加权（页数多的样本信噪比高），并给出样本量，样本 < 3 时前端应显示「样本太少」。
 * 总量是「跨所有书混算」；by_book 按 plan 分组给出每本书各自的反推值。
 * difficulty_factors 以难度 2（名义 1.0）为基准归一化，对比名义 0.85/1.0/1.35。
 */
studyRouter.get("/study/calibration", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const spaceId = String(req.query.space_id || "");
    if (!spaceId) throw new Error("缺少 space_id");
    const admin = createAdminClient();
    await assertSpaceMember(admin, spaceId, auth.user.id);

    const { data: plans, error: planErr } = await admin
      .from("study_plans")
      .select("id, params, book_title")
      .eq("space_id", spaceId)
      .eq("user_id", auth.user.id)
      .order("created_at", { ascending: false });
    if (planErr) throw new Error(planErr.message);

    const planIds = (plans ?? []).map((p) => p.id as string);
    if (planIds.length === 0) {
      res.json({
        samples: 0,
        suggested_min_per_page: null,
        current_min_per_page: null,
        planned_minutes: 0,
        actual_minutes: 0,
        bias_percent: null,
        items: [],
        by_book: [],
        difficulty_factors: [],
      });
      return;
    }

    const bookTitleOf = new Map<string, string>();
    for (const p of plans ?? []) {
      bookTitleOf.set(
        p.id as string,
        String(p.book_title || "").trim() || "未命名计划",
      );
    }

    const { data: items, error: itemErr } = await admin
      .from("study_plan_items")
      .select("id, title, pages, difficulty, minutes, actual_minutes, plan_id")
      .in("plan_id", planIds)
      .not("actual_minutes", "is", null);
    if (itemErr) throw new Error(itemErr.message);

    const usable = (items ?? []).filter(
      (i) => Number(i.actual_minutes) > 0 && Number(i.pages) > 0,
    );

    let pageWeight = 0;
    let actualTotal = 0;
    let plannedTotal = 0;
    for (const i of usable) {
      pageWeight += Number(i.pages) * difficultyFactor(i.difficulty);
      actualTotal += Number(i.actual_minutes);
      plannedTotal += Number(i.minutes);
    }

    // 当前速度取最近一次计划的参数（plans 已按 created_at desc 排序）
    const current = plans?.length
      ? clampMinPerPage((plans[0].params as any)?.min_per_page)
      : null;

    // 按书（plan）分组：每本书独立反推，避免不同书速度混算
    const bookAgg = new Map<
      string,
      { pageWeight: number; actual: number; planned: number; samples: number }
    >();
    for (const i of usable) {
      const pid = String(i.plan_id || "");
      const agg = bookAgg.get(pid) ?? {
        pageWeight: 0,
        actual: 0,
        planned: 0,
        samples: 0,
      };
      agg.pageWeight += Number(i.pages) * difficultyFactor(i.difficulty);
      agg.actual += Number(i.actual_minutes);
      agg.planned += Number(i.minutes);
      agg.samples += 1;
      bookAgg.set(pid, agg);
    }
    const by_book = Array.from(bookAgg.entries())
      .sort((a, b) => b[1].samples - a[1].samples)
      .map(([pid, b]) => ({
        plan_id: pid,
        book_title: bookTitleOf.get(pid) || "未命名计划",
        samples: b.samples,
        suggested_min_per_page:
          b.pageWeight > 0 ? Math.round((b.actual / b.pageWeight) * 10) / 10 : null,
        planned_minutes: b.planned,
        actual_minutes: b.actual,
        bias_percent:
          b.planned > 0 ? Math.round(((b.actual - b.planned) / b.planned) * 100) : null,
      }));

    // 难度系数偏差：各难度档的实际每页分钟，以难度 2（名义 1.0）为基准归一化
    const perDiff = new Map<
      number,
      { pages: number; actual: number; samples: number }
    >();
    for (const i of usable) {
      const d = normalizeDifficulty(i.difficulty);
      if (d === null) continue;
      const agg = perDiff.get(d) ?? { pages: 0, actual: 0, samples: 0 };
      agg.pages += Number(i.pages);
      agg.actual += Number(i.actual_minutes);
      agg.samples += 1;
      perDiff.set(d, agg);
    }
    const base = perDiff.get(2);
    const basePerPage = base && base.pages > 0 ? base.actual / base.pages : null;
    const difficulty_factors = [1, 2, 3].flatMap((d) => {
      const agg = perDiff.get(d);
      if (!agg || agg.pages <= 0) return [];
      const perPage = agg.actual / agg.pages;
      const actualFactor =
        basePerPage && basePerPage > 0
          ? Math.round((perPage / basePerPage) * 100) / 100
          : null;
      return [
        {
          difficulty: d,
          samples: agg.samples,
          actual_factor: actualFactor,
          nominal_factor: difficultyFactor(d),
        },
      ];
    });

    res.json({
      samples: usable.length,
      total_pages: Math.round(pageWeight * 10) / 10,
      suggested_min_per_page:
        pageWeight > 0 ? Math.round((actualTotal / pageWeight) * 10) / 10 : null,
      current_min_per_page: current,
      planned_minutes: plannedTotal,
      actual_minutes: actualTotal,
      bias_percent:
        plannedTotal > 0
          ? Math.round(((actualTotal - plannedTotal) / plannedTotal) * 100)
          : null,
      items: usable.map((i) => ({
        id: i.id,
        title: i.title,
        pages: i.pages,
        difficulty: i.difficulty,
        minutes: i.minutes,
        actual_minutes: i.actual_minutes,
      })),
      by_book,
      difficulty_factors,
    });
  } catch (err) {
    fail(res, err);
  }
});

/** 供前端「今天学什么」用：某计划在某天的学习块 */

studyRouter.get("/study/plans/:id/today", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const planId = String(req.params.id || "");
    const timezone = String(req.query.timezone || "Asia/Shanghai");
    const admin = createAdminClient();

    const { data: plan, error } = await admin
      .from("study_plans")
      .select("id, space_id, book_title, params")
      .eq("id", planId)
      .single();
    if (error || !plan) throw new Error("学习计划不存在");
    await assertSpaceMember(admin, plan.space_id as string, auth.user.id);

    const today = todayInTz(timezone);
    const tomorrow = addDays(today, 1);

    const { data: items } = await admin
      .from("study_plan_items")
      .select("id, seq, title, minutes, scheduled_start, scheduled_end, todo_id, status")
      .eq("plan_id", planId)
      .gte("scheduled_start", `${today}T00:00:00`)
      .lt("scheduled_start", `${tomorrow}T00:00:00`)
      .order("scheduled_start", { ascending: true });

    res.json({ date: today, items: items ?? [] });
  } catch (err) {
    fail(res, err);
  }
});

/* -------------------------------------------------------------------------- */
/* 5) 删除计划                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * DELETE /ai/study/plans/:id
 *
 * 权限：计划创建者本人，或该空间 owner/admin（与 RLS 的 delete policy 一致）。
 *
 * `with_todos=1` 时，连同 apply 阶段生成的待办一起删掉。
 * 默认不带：只删计划本身（study_plan_items 随计划级联删除），日历上的待办留着。
 * 为什么要问：已生成的待办可能已经被勾了完成、或被派给别人，悄悄删掉会丢数据。
 */
studyRouter.delete("/study/plans/:id", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const planId = String(req.params.id || "");
    const withTodos = String(req.query.with_todos || "") === "1";
    const admin = createAdminClient();

    const { data: plan, error } = await admin
      .from("study_plans")
      .select("id, space_id, user_id, book_title")
      .eq("id", planId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!plan) throw new Error("学习计划不存在");

    const member = await assertSpaceMember(admin, plan.space_id as string, auth.user.id);
    const isOwner = plan.user_id === auth.user.id;
    const isSpaceAdmin = member.role === "owner" || member.role === "admin";
    if (!isOwner && !isSpaceAdmin) {
      throw new Error("Not a member of this space: 只有计划创建者或空间管理员能删除");
    }

    // 先收 todo_id，再删计划（items 会级联删掉，之后就查不到了）
    const { data: items, error: itemErr } = await admin
      .from("study_plan_items")
      .select("todo_id")
      .eq("plan_id", planId);
    if (itemErr) throw new Error(itemErr.message);

    const todoIds = (items ?? [])
      .map((i) => i.todo_id as string | null)
      .filter((id): id is string => Boolean(id));

    let todoDeleted = 0;
    if (withTodos && todoIds.length > 0) {
      const { error: todoErr } = await admin.from("todos").delete().in("id", todoIds);
      if (todoErr) throw new Error(todoErr.message);
      todoDeleted = todoIds.length;
    }

    const { error: delErr } = await admin.from("study_plans").delete().eq("id", planId);
    if (delErr) throw new Error(delErr.message);

    res.json({
      deleted: true,
      plan_id: planId,
      book_title: plan.book_title,
      todo_deleted: todoDeleted,
      todo_kept: todoIds.length - todoDeleted,
    });
  } catch (err) {
    fail(res, err);
  }
});

// 保留导出，避免误删工具函数（countStudyDays 供后续「进度落后预警」复用）
export const __studyHelpers = { countStudyDays };
