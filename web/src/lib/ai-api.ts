import { createClient } from "@/lib/supabase/client";

export function getApiBaseUrl() {
  let base = (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (!base) return "";
  // 漏写协议时浏览器会当成相对路径 → 404；自动补全 https
  if (!/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }
  return base;
}

export class AiApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function authHeaders() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new AiApiError("请先登录", 401);
  }
  return {
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  };
}

export async function aiFetch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const base = getApiBaseUrl();
  if (!base) {
    throw new AiApiError(
      "未配置 NEXT_PUBLIC_API_URL，请在 .env.local 填写后端地址",
      0,
    );
  }

  const headers = await authHeaders();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errObj = data as { error?: string } | null;
    throw new AiApiError(
      errObj?.error || `请求失败（${res.status}）`,
      res.status,
    );
  }

  return data as T;
}

export type AiTodoPreview = {
  title: string;
  description?: string | null;
  priority: "high" | "medium" | "low";
  assignee_names?: string[];
  assignee_ids?: string[];
  start_at?: string | null;
  end_at?: string | null;
  due_at?: string | null;
  is_all_day?: boolean;
};

export type CreateTodosPreview = {
  preview: true;
  summary: string | null;
  todos: AiTodoPreview[];
};

export type CreateTodosResult = {
  preview: false;
  summary: string | null;
  todo_ids: string[];
  todos: AiTodoPreview[];
};

export type ScheduleSuggestion = {
  todo_id: string;
  title: string;
  start_at: string;
  end_at: string;
  reason?: string;
};

export type ScheduleSkipped = {
  todo_id: string;
  title: string;
  reason: string;
};

export type SchedulePreview = {
  preview: true;
  suggestions: ScheduleSuggestion[];
  skipped?: ScheduleSkipped[];
  message?: string;
};

export type ScheduleResult = {
  preview: false;
  applied: string[];
  suggestions: ScheduleSuggestion[];
  skipped?: ScheduleSkipped[];
  message?: string;
};

export type ConflictMove = {
  todo_id: string;
  title: string;
  from_start_at: string;
  from_end_at: string;
  to_start_at: string;
  to_end_at: string;
  reason: string;
};

export type ConflictItem = {
  id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  assignees: string[];
};

export type ConflictPreview = {
  preview: true;
  conflicts: Array<{ a: string; b: string }>;
  conflicts_detail?: ConflictItem[];
  suggestions: ConflictMove[];
  message?: string;
};

export type ConflictResult = {
  preview: false;
  conflicts: Array<{ a: string; b: string }>;
  conflicts_detail?: ConflictItem[];
  suggestions: ConflictMove[];
  applied: string[];
  skipped?: ScheduleSkipped[];
  message?: string;
};

export type ReorderResult = {
  todos: Array<{
    id: string;
    title: string;
    priority: string;
    status: string;
    due_at: string | null;
    start_at: string | null;
    sort_score: number;
  }>;
};

export type DailySummaryResult = {
  notification_id: string;
  date: string;
  summary: string;
  today_count: number;
};

export type PlainTaskInput = {
  id: string;
  title: string;
  status?: string;
  category?: string;
  /** 以下为客观依据，交给 AI 把描述写具体；没有就不传 */
  space_name?: string;
  time_label?: string;
  date_iso?: string | null;
  priority?: string;
  description?: string | null;
  assignees?: string[];
  /** 协作评价 / 评论：成员在任务下留下的沟通记录、进展或反馈，作为 AI 写周报的补充依据 */
  comments?: string[];
};

export type PlainTaskResult = {
  items: Array<{ id: string; text: string }>;
};

/** AI 把任务名称改写成严谨、具体、术语克制的任务描述 */
export function plainTaskDescriptions(tasks: PlainTaskInput[]) {
  return aiFetch<PlainTaskResult>("/ai/report-plain", { tasks });
}

export function createTodos(params: {
  space_id: string;
  text: string;
  confirm?: boolean;
  timezone?: string;
}) {
  return aiFetch<CreateTodosPreview | CreateTodosResult>("/ai/create-todos", {
    space_id: params.space_id,
    text: params.text,
    confirm: params.confirm ?? false,
    timezone: params.timezone || "Asia/Shanghai",
  });
}

export function scheduleTodos(params: {
  space_id?: string;
  all_spaces?: boolean;
  text?: string;
  todo_ids?: string[];
  include_unscheduled?: boolean;
  confirm?: boolean;
  timezone?: string;
}) {
  return aiFetch<
    SchedulePreview | ScheduleResult | { suggestions: []; message: string }
  >("/ai/schedule", {
    ...(params.all_spaces
      ? { all_spaces: true }
      : { space_id: params.space_id }),
    text: params.text,
    ...(params.todo_ids?.length ? { todo_ids: params.todo_ids } : {}),
    include_unscheduled: params.include_unscheduled ?? true,
    confirm: params.confirm ?? false,
    timezone: params.timezone || "Asia/Shanghai",
  });
}

export function conflictSuggest(params: {
  space_id?: string;
  all_spaces?: boolean;
  confirm?: boolean;
  user_id?: string;
}) {
  return aiFetch<
    | ConflictPreview
    | ConflictResult
    | { conflicts: []; suggestions: []; message: string }
  >("/ai/conflict-suggest", {
    ...(params.all_spaces
      ? { all_spaces: true }
      : { space_id: params.space_id }),
    confirm: params.confirm ?? false,
    user_id: params.user_id,
  });
}

export function reorderTodos(params: {
  space_id?: string;
  all_spaces?: boolean;
  persist?: boolean;
}) {
  return aiFetch<ReorderResult>("/ai/reorder", {
    ...(params.all_spaces
      ? { all_spaces: true }
      : { space_id: params.space_id }),
    persist: params.persist ?? true,
  });
}

export function dailySummary(params: {
  space_id?: string;
  timezone?: string;
}) {
  return aiFetch<DailySummaryResult>("/ai/daily-summary", {
    space_id: params.space_id,
    timezone: params.timezone || "Asia/Shanghai",
  });
}

export type KnowledgeStep = {
  no: number;
  title: string;
  action: string;
  depends_on: number[];
  expected: string;
};

export type KnowledgeSource = {
  id: string;
  space_id: string;
  user_id: string;
  type: "web" | "feishu";
  title: string;
  url: string | null;
  status: string;
  error: string | null;
  created_at: string;
};

export type KnowledgePlan = {
  id: string;
  space_id: string;
  user_id: string;
  question: string;
  summary: string | null;
  plan_json: { summary?: string; steps?: KnowledgeStep[] };
  sources: Array<{ id: string; title: string }>;
  status: "pending" | "confirmed" | "applied" | "failed";
  created_at: string;
};

/** 知识源 GET 请求：现有 aiFetch 只支持 POST body，这里单独拼 query 走 fetch */
export async function listKnowledgeSources(spaceId: string) {
  const base = getApiBaseUrl();
  if (!base) {
    throw new AiApiError(
      "未配置 NEXT_PUBLIC_API_URL，请在 .env.local 填写后端地址",
      0,
    );
  }

  const headers = await authHeaders();
  const res = await fetch(
    `${base}/ai/knowledge/sources?space_id=${encodeURIComponent(spaceId)}`,
    { method: "GET", headers },
  );

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errObj = data as { error?: string } | null;
    throw new AiApiError(
      errObj?.error || `请求失败（${res.status}）`,
      res.status,
    );
  }

  return data as { sources: KnowledgeSource[] };
}

export function addKnowledgeSource(params: {
  space_id: string;
  type: "web" | "feishu";
  url: string;
  title?: string;
}) {
  return aiFetch<{ source: KnowledgeSource }>("/ai/knowledge/sources", {
    space_id: params.space_id,
    type: params.type,
    url: params.url,
    ...(params.title ? { title: params.title } : {}),
  });
}

export function decomposeProblem(params: {
  space_id: string;
  question: string;
  source_ids?: string[];
}) {
  return aiFetch<{ preview: true; plan: KnowledgePlan }>(
    "/ai/knowledge/decompose",
    {
      space_id: params.space_id,
      question: params.question,
      ...(params.source_ids?.length ? { source_ids: params.source_ids } : {}),
    },
  );
}

export function confirmPlan(params: { space_id: string; plan_id: string }) {
  return aiFetch<{ confirmed: true; plan: KnowledgePlan }>(
    "/ai/knowledge/confirm",
    { space_id: params.space_id, plan_id: params.plan_id },
  );
}

export function applyPlan(params: { space_id: string; plan_id: string }) {
  return aiFetch<{ applied: true; plan_id: string; todo_ids: string[] }>(
    "/ai/knowledge/apply",
    { space_id: params.space_id, plan_id: params.plan_id },
  );
}

/** 资料类型：doc=Markdown 文档 / table=表格 / board=看板 */
export type DocKind = "doc" | "table" | "board";

/** 资料板块文档（不含正文的列表项） */
export type DocMeta = {
  id: string;
  space_id: string;
  creator_id: string;
  kind: DocKind;
  title: string;
  created_at: string;
  updated_at: string;
};

/** 资料板块文档（含 Markdown 正文） */
export type Doc = DocMeta & {
  content: string;
};

/** 资料板块附件元数据 */
export type Attachment = {
  id: string;
  space_id: string;
  doc_id: string | null;
  uploader_id: string;
  bucket_path: string;
  name: string;
  size: number;
  mime_type: string | null;
  created_at: string;
};

/** 通用 JSON 请求（docs / study 等需要 GET/PATCH/DELETE 的端点），复用 authHeaders 与错误处理模式 */
async function jsonFetch<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const base = getApiBaseUrl();
  if (!base) {
    throw new AiApiError(
      "未配置 NEXT_PUBLIC_API_URL，请在 .env.local 填写后端地址",
      0,
    );
  }

  const headers = await authHeaders();
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errObj = data as { error?: string } | null;
    throw new AiApiError(
      errObj?.error || `请求失败（${res.status}）`,
      res.status,
    );
  }

  return data as T;
}

export function listDocs(spaceId: string) {
  return jsonFetch<{ docs: DocMeta[] }>(
    "GET",
    `/docs?space_id=${encodeURIComponent(spaceId)}`,
  );
}

export function createDoc(params: {
  space_id: string;
  title: string;
  content?: string;
  kind?: DocKind;
}) {
  return jsonFetch<{ doc: Doc }>("POST", "/docs", {
    space_id: params.space_id,
    title: params.title,
    ...(params.content !== undefined ? { content: params.content } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
  });
}

export function getDoc(docId: string) {
  return jsonFetch<{ doc: Doc }>("GET", `/docs/${docId}`);
}

export function updateDoc(
  docId: string,
  params: { title?: string; content?: string },
) {
  return jsonFetch<{ doc: Doc }>("PATCH", `/docs/${docId}`, { ...params });
}

export function deleteDoc(docId: string) {
  return jsonFetch<{ deleted: true }>("DELETE", `/docs/${docId}`);
}

export function registerAttachment(params: {
  space_id: string;
  doc_id?: string | null;
  bucket_path: string;
  name: string;
  size: number;
  mime_type?: string;
}) {
  return jsonFetch<{ attachment: Attachment }>("POST", "/docs/attachments", {
    space_id: params.space_id,
    doc_id: params.doc_id ?? null,
    bucket_path: params.bucket_path,
    name: params.name,
    size: params.size,
    ...(params.mime_type ? { mime_type: params.mime_type } : {}),
  });
}

export function listAttachments(spaceId: string, docId?: string) {
  const query = docId
    ? `space_id=${encodeURIComponent(spaceId)}&doc_id=${encodeURIComponent(docId)}`
    : `space_id=${encodeURIComponent(spaceId)}`;
  return jsonFetch<{ attachments: Attachment[] }>(
    "GET",
    `/docs/attachments?${query}`,
  );
}

export function deleteAttachment(id: string) {
  return jsonFetch<{ deleted: true }>("DELETE", `/docs/attachments/${id}`);
}

/* -------------------------------------------------------------------------- */
/* 学习计划（/app/study）                                                       */
/* -------------------------------------------------------------------------- */

/** 目录里的一项（后端 normalizeChapters 之后的形状） */
export type StudyChapter = {
  no: number | null;
  title: string;
  level: number | null;
  parent_no: number | null;
  minutes: number;
  /** 可校准量：这一项在教材上约多少页；老数据可能为 null */
  pages?: number | null;
  /** 可校准量：1=概念/记忆 2=普通 3=证明/计算密集 */
  difficulty?: number | null;
};

/**
 * 估时公式（与后端 services/study.ts 的 estimateMinutes 必须一致）：
 *   minutes = pages × minPerPage × 难度系数
 * 前端用它做「改页数/难度/每页分钟 → 立刻重算」，不调 AI。
 */
export const DIFFICULTY_LABEL: Record<number, string> = {
  1: "概念型",
  2: "普通",
  3: "证明/计算型",
};

export const DIFFICULTY_FACTOR: Record<number, number> = {
  1: 0.85,
  2: 1,
  3: 1.35,
};

export const DEFAULT_MIN_PER_PAGE = 7;

export function estimateChapterMinutes(
  pages: number | null | undefined,
  difficulty: number | null | undefined,
  minPerPage: number,
): number {
  const p = Number(pages);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const speed = Math.min(20, Math.max(1, Number(minPerPage) || DEFAULT_MIN_PER_PAGE));
  const d = Math.min(3, Math.max(1, Math.round(Number(difficulty) || 2)));
  const raw = p * speed * (DIFFICULTY_FACTOR[d] ?? 1);
  return Math.max(5, Math.round(raw / 5) * 5);
}

/** 排期参数（原样落库到 study_plans.params） */
export type StudyParams = {
  daily_start: string;
  daily_end: string;
  daily_minutes_cap: number | null;
  weekdays: number[];
  start_date: string;
  deadline: string | null;
  unit_minutes: number;
  min_per_page?: number | null;
  timezone: string;
};

export type StudyDeadlineFit = {
  deadline: string;
  feasible: boolean;
  capacity_minutes: number;
  deficit_minutes: number;
  extra_per_day: number;
  available_days: number;
};

export type StudySummary = {
  total_minutes: number;
  placed_minutes: number;
  total_units: number;
  placed_units: number;
  days_needed: number;
  start_date: string;
  end_date: string | null;
  daily_avg_minutes: number;
  deadline_fit: StudyDeadlineFit | null;
  warnings: string[];
};

export type StudyOutline = {
  book_title: string;
  chapters: StudyChapter[];
  /** book/text/feishu = 有真实来源；ai = 模型凭记忆生成的草案 */
  source: "feishu" | "text" | "book" | "ai";
  source_url: string | null;
  confidence: "high" | "low";
  needs_review: boolean;
  note: string;
  stats: {
    chapter_count: number;
    total_minutes: number;
    total_pages?: number;
    min_per_page?: number;
    pages_known?: number;
  };
};

export type StudyPreviewSlot = {
  date: string;
  minutes: number;
  seq: number;
  title: string;
  start_at: string;
  end_at: string;
};

export type StudyPreviewDay = {
  date: string;
  minutes: number;
  items: StudyPreviewSlot[];
};

export type StudyUnplaced = {
  seq: number;
  title: string;
  chapter_no: number | null;
  minutes: number;
};

export type StudyPlanPreview = {
  preview: true;
  plan: {
    id: string;
    book_title: string;
    status: string;
    params: StudyParams;
    summary: StudySummary;
  };
  days: StudyPreviewDay[];
  unplaced: StudyUnplaced[];
  warnings: string[];
};

export type StudyProgress = {
  total_units: number;
  done_units: number;
  total_minutes: number;
  done_minutes: number;
};

/** 计划列表项（GET /ai/study/plans） */
export type StudyPlanMeta = {
  id: string;
  space_id: string;
  user_id: string;
  book_title: string;
  source_type: string;
  outline_meta: Record<string, unknown>;
  params: StudyParams;
  summary: StudySummary;
  status: "planned" | "applied" | "archived";
  created_at: string;
  progress: StudyProgress;
};

export type StudyPlanItem = {
  id: string;
  seq: number;
  title: string;
  chapter_no: number | null;
  minutes: number;
  pages: number | null;
  difficulty: number | null;
  /** 用户填的真实用时；null = 未校准 */
  actual_minutes: number | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  todo_id: string | null;
  status: string | null;
};

/** 校准报告（GET /ai/study/calibration） */
export type StudyCalibration = {
  samples: number;
  total_pages?: number;
  suggested_min_per_page: number | null;
  current_min_per_page: number | null;
  planned_minutes: number;
  actual_minutes: number;
  bias_percent: number | null;
  items: Array<{
    id: string;
    title: string;
    pages: number;
    difficulty: number | null;
    minutes: number;
    actual_minutes: number;
  }>;
  /** 按书（plan）分组：每本书独立反推的每页分钟 */
  by_book: Array<{
    plan_id: string;
    book_title: string;
    samples: number;
    suggested_min_per_page: number | null;
    planned_minutes: number;
    actual_minutes: number;
    bias_percent: number | null;
  }>;
  /** 难度系数偏差：实际系数（难度2=1.0 归一化）vs 名义 0.85/1.0/1.35 */
  difficulty_factors: Array<{
    difficulty: number;
    samples: number;
    actual_factor: number | null;
    nominal_factor: number;
  }>;
};

/** 计划详情（GET /ai/study/plans/:id） */
export type StudyPlanDetail = {
  plan: StudyPlanMeta & {
    source_url: string | null;
    outline: StudyChapter[];
    outline_meta: Record<string, unknown>;
  };
  items: StudyPlanItem[];
  days: Array<{
    date: string;
    minutes: number;
    items: Array<{
      date: string;
      minutes: number;
      id: string;
      seq: number;
      title: string;
      pages?: number | null;
      difficulty?: number | null;
      actual_minutes?: number | null;
      start_at: string;
      end_at: string;
      todo_id: string | null;
      status: string | null;
    }>;
  }>;
};

export function studyOutline(params: {
  space_id: string;
  source: "feishu" | "text" | "book";
  url?: string;
  text?: string;
  book_title?: string;
  author?: string;
  subject?: string;
  min_per_page?: number;
}) {
  return aiFetch<StudyOutline>("/ai/study/outline", { ...params });
}

export function previewStudyPlan(params: {
  space_id: string;
  book_title: string;
  chapters: StudyChapter[];
  source_type?: "feishu" | "text" | "book";
  source_url?: string | null;
  outline_meta?: Record<string, unknown>;
  daily_start?: string;
  daily_end?: string;
  daily_minutes_cap?: number | null;
  weekdays?: number[];
  start_date?: string;
  deadline?: string | null;
  unit_minutes?: number;
  min_per_page?: number | null;
  timezone?: string;
}) {
  return aiFetch<StudyPlanPreview>("/ai/study/plan", { ...params });
}

/** 记录学习块真实用时（校准数据来源） */
export function saveStudyItemActual(itemId: string, actualMinutes: number) {
  return jsonFetch<{ ok: true; id: string; actual_minutes: number }>(
    "PATCH",
    `/ai/study/items/${encodeURIComponent(itemId)}/actual`,
    { actual_minutes: actualMinutes },
  );
}

/** 校准报告：用实际用时反推建议 min_per_page */
export function getStudyCalibration(spaceId: string) {
  return jsonFetch<StudyCalibration>(
    "GET",
    `/ai/study/calibration?space_id=${encodeURIComponent(spaceId)}`,
  );
}

export function applyStudyPlan(params: { space_id: string; plan_id: string }) {
  return aiFetch<{
    applied: true;
    plan_id: string;
    todo_count: number;
    todo_ids: string[];
  }>("/ai/study/apply", { ...params });
}

export function listStudyPlans(spaceId?: string) {
  const query = spaceId ? `?space_id=${encodeURIComponent(spaceId)}` : "";
  return jsonFetch<{ plans: StudyPlanMeta[] }>("GET", `/ai/study/plans${query}`);
}

export function getStudyPlan(planId: string) {
  return jsonFetch<StudyPlanDetail>(
    "GET",
    `/ai/study/plans/${encodeURIComponent(planId)}`,
  );
}

/** 删除学习计划；withTodos=true 时连带删掉 apply 阶段生成的待办 */
export function deleteStudyPlan(planId: string, withTodos = false) {
  const query = withTodos ? "?with_todos=1" : "";
  return jsonFetch<{
    deleted: true;
    plan_id: string;
    book_title: string;
    todo_deleted: number;
    todo_kept: number;
  }>("DELETE", `/ai/study/plans/${encodeURIComponent(planId)}${query}`);
}
