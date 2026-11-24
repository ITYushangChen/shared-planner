"use client";

import { useEffect, useState } from "react";
import {
  addKnowledgeSource,
  applyPlan,
  confirmPlan,
  decomposeProblem,
  listKnowledgeSources,
  AiApiError,
  type KnowledgePlan,
  type KnowledgeSource,
} from "@/lib/ai-api";
import type { SpaceNavItem } from "@/lib/todos";
import { primaryBtnClass, secondaryBtnClass } from "../ui-btn-class";

type Props = {
  spaces: SpaceNavItem[];
};

const TYPE_LABEL: Record<"web" | "feishu", string> = {
  web: "网页",
  feishu: "飞书文档",
};

const STATUS_LABEL: Record<string, string> = {
  ready: "可用",
  fetching: "抓取中",
  failed: "失败",
};

function errText(e: unknown): string {
  if (e instanceof AiApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "未知错误";
}

export function KnowledgeWorkspace({ spaces }: Props) {
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
  const [sourceType, setSourceType] = useState<"web" | "feishu">("web");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [addBusy, setAddBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [decomposeBusy, setDecomposeBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [appliedTodoCount, setAppliedTodoCount] = useState<number | null>(null);
  const [plan, setPlan] = useState<KnowledgePlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 切换空间时重新拉取该空间的知识源
  useEffect(() => {
    if (!spaceId) {
      setSources([]);
      setSelectedSourceIds(new Set());
      setPlan(null);
      return;
    }
    let cancelled = false;
    setSourcesLoading(true);
    setError(null);
    void listKnowledgeSources(spaceId)
      .then(({ sources: list }) => {
        if (cancelled) return;
        setSources(list);
        setSelectedSourceIds(new Set(list.map((s) => s.id)));
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  function toggleSource(id: string) {
    setSelectedSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAddSource() {
    if (!spaceId || !sourceUrl.trim()) return;
    setAddBusy(true);
    setError(null);
    try {
      await addKnowledgeSource({
        space_id: spaceId,
        type: sourceType,
        url: sourceUrl.trim(),
        ...(sourceTitle.trim() ? { title: sourceTitle.trim() } : {}),
      });
      setSourceUrl("");
      setSourceTitle("");
      const { sources: list } = await listKnowledgeSources(spaceId);
      setSources(list);
      setSelectedSourceIds(new Set(list.map((s) => s.id)));
    } catch (e) {
      setError(errText(e));
    } finally {
      setAddBusy(false);
    }
  }

  async function handleDecompose() {
    if (!spaceId || !question.trim()) return;
    setDecomposeBusy(true);
    setError(null);
    setPlan(null);
    try {
      const { plan: newPlan } = await decomposeProblem({
        space_id: spaceId,
        question: question.trim(),
        source_ids: Array.from(selectedSourceIds),
      });
      setPlan(newPlan);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDecomposeBusy(false);
    }
  }

  async function handleConfirm() {
    if (!spaceId || !plan) return;
    setConfirmBusy(true);
    setError(null);
    try {
      const { plan: updated } = await confirmPlan({
        space_id: spaceId,
        plan_id: plan.id,
      });
      setPlan(updated);
    } catch (e) {
      setError(errText(e));
    } finally {
      setConfirmBusy(false);
    }
  }

  async function handleApply() {
    if (!spaceId || !plan) return;
    setApplyBusy(true);
    setError(null);
    try {
      const { todo_ids } = await applyPlan({
        space_id: spaceId,
        plan_id: plan.id,
      });
      setAppliedTodoCount(todo_ids.length);
      setPlan((prev) => (prev ? { ...prev, status: "applied" } : prev));
    } catch (e) {
      setError(errText(e));
    } finally {
      setApplyBusy(false);
    }
  }

  if (spaces.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <p className="text-sm text-[var(--text-muted)]">
          还没有可用的空间，请先创建或加入一个空间。
        </p>
      </div>
    );
  }

  const steps = plan?.plan_json?.steps ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-lg font-semibold text-[var(--brand-ink)]">知识板块</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        连接知识源（网页 / 飞书文档），把问题拆解成可逐步执行的方案。
      </p>

      {error ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {/* 空间选择 */}
      <div className="mt-4">
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
          空间
        </label>
        <select
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
          className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
        >
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* 知识源 */}
      <section className="mt-6 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
        <h2 className="text-sm font-semibold text-[var(--brand-ink)]">知识源</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["web", "feishu"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSourceType(t)}
              className={[
                "inline-flex h-8 shrink-0 items-center rounded-full px-3 text-sm font-medium transition-colors duration-200",
                sourceType === t
                  ? "bg-[#185FA5] text-white"
                  : "border border-[#2f5f8f]/50 bg-white text-[#2f5f8f] hover:bg-[#e8f0f7]",
              ].join(" ")}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder={
              sourceType === "web"
                ? "网页链接 https://…"
                : "飞书文档链接 https://…/docx/…"
            }
            className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
          />
          <input
            type="text"
            value={sourceTitle}
            onChange={(e) => setSourceTitle(e.target.value)}
            placeholder="标题（可选，留空自动抓取）"
            className="w-full rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
          />
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={handleAddSource}
            disabled={addBusy || !sourceUrl.trim()}
            className={primaryBtnClass()}
          >
            {addBusy ? "抓取中…" : "添加知识源"}
          </button>
        </div>

        {sourcesLoading ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">加载知识源…</p>
        ) : sources.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            还没有知识源，先在上方添加一个。
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex items-start gap-2 rounded-xl border border-[var(--border-muted)] px-3 py-2"
              >
                <input
                  type="checkbox"
                  checked={selectedSourceIds.has(s.id)}
                  onChange={() => toggleSource(s.id)}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--brand-ink)]">
                    {s.title}
                  </p>
                  <p className="truncate text-xs text-[var(--text-muted)]">
                    {TYPE_LABEL[s.type] ?? s.type} · {s.url}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                  {STATUS_LABEL[s.status] ?? s.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 问题拆解 */}
      <section className="mt-6 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
        <h2 className="text-sm font-semibold text-[var(--brand-ink)]">
          问题拆解
        </h2>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          placeholder="输入你要解决的问题，例如：如何给新项目搭建自动化测试流程？"
          className="mt-3 w-full resize-y rounded-xl border border-[var(--border-muted)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none focus:border-brand"
        />
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={handleDecompose}
            disabled={decomposeBusy || !question.trim()}
            className={primaryBtnClass()}
          >
            {decomposeBusy ? "拆解中…" : "拆解问题"}
          </button>
        </div>
      </section>

      {/* 方案结果 */}
      {plan ? (
        <section className="mt-6 rounded-2xl border border-[var(--border-muted)] bg-white p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--brand-ink)]">
              执行方案
            </h2>
            <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
              {plan.status === "applied"
                ? "已生成待办"
                : plan.status === "confirmed"
                  ? "已确认"
                  : "待确认"}
            </span>
          </div>

          {plan.summary || plan.plan_json?.summary ? (
            <p className="mt-3 text-sm leading-relaxed text-[var(--brand-ink)]">
              {plan.summary || plan.plan_json?.summary}
            </p>
          ) : null}

          <ol className="mt-4 space-y-3">
            {steps.map((step) => (
              <li
                key={step.no}
                className="rounded-xl border border-[var(--border-muted)] px-3 py-2.5"
              >
                <div className="flex items-start gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#185FA5] text-xs font-semibold text-white">
                    {step.no}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--brand-ink)]">
                      {step.title}
                    </p>
                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                      {step.action}
                    </p>
                    {step.expected ? (
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        预期：{step.expected}
                      </p>
                    ) : null}
                    {step.depends_on?.length ? (
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        依赖步骤：{step.depends_on.join("、")}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          {plan.status === "pending" ? (
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={handleConfirm}
                disabled={confirmBusy}
                className={secondaryBtnClass()}
              >
                {confirmBusy ? "确认中…" : "确认方案"}
              </button>
            </div>
          ) : plan.status === "confirmed" ? (
            <div className="mt-4 flex flex-col items-end gap-2">
              <button
                type="button"
                onClick={handleApply}
                disabled={applyBusy}
                className={primaryBtnClass()}
              >
                {applyBusy ? "生成中…" : "一键生成待办"}
              </button>
              <p className="text-xs text-[var(--text-muted)]">
                将按步骤生成 {steps.length} 个待办，前置依赖与预期写入描述。
              </p>
            </div>
          ) : null}

          {plan.status === "applied" ? (
            <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              已生成 {appliedTodoCount ?? 0} 个待办，可到「待办」页查看并排期。
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
