"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  BG_POSITION_OPTIONS,
  BG_SIZE_OPTIONS,
  DEFAULT_BG_COLOR,
  DEFAULT_BG_OPACITY,
  DEFAULT_BG_POSITION,
  DEFAULT_BG_SIZE,
  DEFAULT_PRIORITY_COLORS,
  DEFAULT_TASK_OPACITY,
  mergePriorityColors,
  parseUiPrefs,
  resolveTaskOpacity,
  type UiPrefs,
} from "@/lib/ui-prefs";
import type { SpaceNavItem } from "@/lib/todos";
import { SettingsFooter, SettingsRow, SettingsSection, fieldClass } from "./settings-ui";
import { secondaryBtnClass } from "../ui-btn-class";

type Scope = "global" | string;
type Snapshot = {
  bgColor: string;
  bgImageUrl: string;
  bgOpacity: number;
  bgSize: string;
  bgPosition: string;
  high: string;
  medium: string;
  low: string;
  taskOpacity: number;
};

const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 5 * 1024 * 1024;

function snapshotOf(prefs: UiPrefs, includePriority: boolean): Snapshot {
  const pc = mergePriorityColors(prefs);
  return {
    bgColor: prefs.bgColor?.trim() || DEFAULT_BG_COLOR,
    bgImageUrl: prefs.bgImageUrl?.trim() || "",
    bgOpacity:
      typeof prefs.bgOpacity === "number" ? prefs.bgOpacity : DEFAULT_BG_OPACITY,
    bgSize: prefs.bgSize?.trim() || DEFAULT_BG_SIZE,
    bgPosition: prefs.bgPosition?.trim() || DEFAULT_BG_POSITION,
    high: includePriority ? pc.high : DEFAULT_PRIORITY_COLORS.high,
    medium: includePriority ? pc.medium : DEFAULT_PRIORITY_COLORS.medium,
    low: includePriority ? pc.low : DEFAULT_PRIORITY_COLORS.low,
    taskOpacity: includePriority
      ? resolveTaskOpacity(prefs)
      : DEFAULT_TASK_OPACITY,
  };
}

type Props = {
  spaces: SpaceNavItem[];
  initialGlobalPrefs?: unknown;
  initialSpacePrefsById?: Record<string, unknown>;
};

export function AppearancePanel({
  spaces,
  initialGlobalPrefs,
  initialSpacePrefsById = {},
}: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [scope, setScope] = useState<Scope>("global");
  const [form, setForm] = useState<Snapshot>(() =>
    snapshotOf(parseUiPrefs(initialGlobalPrefs), true),
  );
  const [initial, setInitial] = useState<Snapshot>(form);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");

  // 切换应用范围时，载入对应范围的已保存值
  useEffect(() => {
    const isGlobal = scope === "global";
    const next = snapshotOf(
      parseUiPrefs(isGlobal ? initialGlobalPrefs : initialSpacePrefsById[scope]),
      isGlobal,
    );
    setForm(next);
    setInitial(next);
    setMsg("");
  }, [scope, initialGlobalPrefs, initialSpacePrefsById]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  function patch(p: Partial<Snapshot>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  function reset() {
    setForm(initial);
    setMsg("");
  }

  async function onPickFile(file: File | null) {
    if (!file) return;
    if (!ALLOWED.includes(file.type)) {
      setMsg("仅支持 JPG / PNG / WebP / GIF");
      return;
    }
    if (file.size > MAX_BYTES) {
      setMsg("图片需小于 5MB");
      return;
    }
    setUploading(true);
    setMsg("上传中…");
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setUploading(false);
      setMsg("请先登录");
      return;
    }
    const ext =
      file.type === "image/png"
        ? "png"
        : file.type === "image/webp"
          ? "webp"
          : file.type === "image/gif"
            ? "gif"
            : "jpg";
    const folder = scope === "global" ? "global" : scope;
    const path = `${user.id}/${folder}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("backgrounds")
      .upload(path, file, { upsert: true, contentType: file.type });
    setUploading(false);
    if (error) {
      setMsg(
        error.message.includes("Bucket not found")
          ? "未找到 backgrounds 存储桶，请先执行 storage 迁移 SQL"
          : error.message,
      );
      return;
    }
    const { data } = supabase.storage.from("backgrounds").getPublicUrl(path);
    patch({ bgImageUrl: data.publicUrl });
    setMsg("图片已上传，记得保存");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      setMsg("请先登录");
      return;
    }

    const bgPatch: UiPrefs = {
      bgColor: form.bgColor.trim() || null,
      bgImageUrl: form.bgImageUrl.trim() || null,
      bgOpacity: form.bgOpacity,
      bgSize: form.bgSize.trim() || DEFAULT_BG_SIZE,
      bgPosition: form.bgPosition.trim() || DEFAULT_BG_POSITION,
    };

    const base = parseUiPrefs(
      scope === "global" ? initialGlobalPrefs : initialSpacePrefsById[scope],
    );

    if (scope === "global") {
      const next: UiPrefs = {
        ...base,
        ...bgPatch,
        priorityColors: {
          high: form.high,
          medium: form.medium,
          low: form.low,
        },
        taskOpacity: form.taskOpacity,
      };
      const { error } = await supabase
        .from("profiles")
        .update({ ui_prefs: next })
        .eq("id", user.id);
      setSaving(false);
      if (error) {
        setMsg(error.message);
        return;
      }
    } else {
      const next: UiPrefs = { ...base, ...bgPatch };
      const { error } = await supabase
        .from("space_members")
        .update({ ui_prefs: next })
        .eq("space_id", scope)
        .eq("user_id", user.id);
      setSaving(false);
      if (error) {
        setMsg(error.message);
        return;
      }
    }

    setInitial(form);
    setMsg("已保存");
    router.refresh();
  }

  async function onClearScope() {
    if (scope === "global") return;
    if (!confirm("清除该空间的自定义背景，恢复为全局外观？")) return;
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      return;
    }
    const { error } = await supabase
      .from("space_members")
      .update({ ui_prefs: {} })
      .eq("space_id", scope)
      .eq("user_id", user.id);
    setSaving(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setMsg("已清除该空间的背景覆盖");
    router.refresh();
  }

  const isGlobal = scope === "global";

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <SettingsSection
        title="应用范围"
        desc="背景会铺满整页（含左侧栏）。可只对某个空间单独覆盖"
      >
        <SettingsRow label="生效范围">
          <select
            className={fieldClass()}
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
          >
            <option value="global">全部空间（全局默认）</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                仅「{s.name}」
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsSection>

      <div className="mt-5">
        <SettingsSection title="背景" desc="背景图铺在下层，上面的内容保持可读">
          <SettingsRow label="背景颜色" hint="图片未覆盖区域的底色">
            <div className="flex items-center gap-2">
              <input
                className={fieldClass()}
                value={form.bgColor}
                onChange={(e) => patch({ bgColor: e.target.value })}
                placeholder={DEFAULT_BG_COLOR}
              />
              <input
                type="color"
                aria-label="选择背景颜色"
                className="h-10 w-12 shrink-0 cursor-pointer rounded border border-[var(--border-muted)]"
                value={
                  /^#[0-9a-fA-F]{6}$/.test(form.bgColor)
                    ? form.bgColor
                    : DEFAULT_BG_COLOR
                }
                onChange={(e) => patch({ bgColor: e.target.value })}
              />
            </div>
          </SettingsRow>

          <SettingsRow label="背景图片" hint="JPG / PNG / WebP / GIF，≤ 5MB">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <label className="inline-flex cursor-pointer items-center rounded-lg border border-[#2f5f8f]/40 bg-[#e8f0f7] px-3 py-1.5 text-xs font-medium text-[#2f5f8f] transition-colors hover:bg-[#2f5f8f] hover:text-white">
                  {uploading ? "上传中…" : "上传图片"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    disabled={uploading || saving}
                    onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                {form.bgImageUrl ? (
                  <button
                    type="button"
                    className="rounded-lg border border-[var(--border-muted)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
                    onClick={() => patch({ bgImageUrl: "" })}
                    disabled={uploading || saving}
                  >
                    移除图片
                  </button>
                ) : null}
              </div>
              <input
                className={fieldClass()}
                value={form.bgImageUrl}
                onChange={(e) => patch({ bgImageUrl: e.target.value })}
                placeholder="或粘贴图片 URL"
              />
              {form.bgImageUrl ? (
                <div
                  className="relative mt-1 h-24 overflow-hidden rounded-lg border border-[var(--border-muted)]"
                  style={{ backgroundColor: form.bgColor }}
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      opacity: form.bgOpacity,
                      backgroundImage: `url(${form.bgImageUrl})`,
                      backgroundSize: form.bgSize,
                      backgroundPosition: form.bgPosition,
                      backgroundRepeat: "no-repeat",
                    }}
                  />
                </div>
              ) : null}
            </div>
          </SettingsRow>

          <SettingsRow
            label={`图片透明度 ${Math.round(form.bgOpacity * 100)}%`}
            hint="调低可让内容更清晰"
          >
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              className="w-full accent-[var(--brand)]"
              value={form.bgOpacity}
              onChange={(e) => patch({ bgOpacity: Number(e.target.value) })}
              disabled={!form.bgImageUrl}
            />
          </SettingsRow>

          <SettingsRow label="图片大小与位置">
            <div className="grid grid-cols-2 gap-2">
              <select
                className={fieldClass()}
                value={form.bgSize}
                onChange={(e) => patch({ bgSize: e.target.value })}
                disabled={!form.bgImageUrl}
              >
                {BG_SIZE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                className={fieldClass()}
                value={form.bgPosition}
                onChange={(e) => patch({ bgPosition: e.target.value })}
                disabled={!form.bgImageUrl}
              >
                {BG_POSITION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </SettingsRow>
        </SettingsSection>
      </div>

      {isGlobal ? (
        <div className="mt-5">
          <SettingsSection
            title="任务颜色"
            desc="新建待办时的默认优先级配色，单条待办仍可单独改色"
          >
            {(
              [
                ["重要", "high"],
                ["中等", "medium"],
                ["不重要", "low"],
              ] as const
            ).map(([label, key]) => (
              <SettingsRow key={key} label={label}>
                <div className="flex items-center gap-2">
                  <input
                    className={fieldClass()}
                    value={form[key]}
                    onChange={(e) => patch({ [key]: e.target.value } as Partial<Snapshot>)}
                  />
                  <input
                    type="color"
                    aria-label={`选择${label}颜色`}
                    className="h-10 w-12 shrink-0 cursor-pointer rounded border border-[var(--border-muted)]"
                    value={
                      /^#[0-9a-fA-F]{6}$/.test(form[key])
                        ? form[key]
                        : DEFAULT_PRIORITY_COLORS[key]
                    }
                    onChange={(e) => patch({ [key]: e.target.value } as Partial<Snapshot>)}
                  />
                </div>
              </SettingsRow>
            ))}
            <SettingsRow
              label={`任务条底色透明度 ${Math.round(form.taskOpacity * 100)}%`}
              hint="影响日历里任务块的浓淡"
            >
              <input
                type="range"
                min={0.15}
                max={1}
                step={0.05}
                className="w-full accent-[var(--brand)]"
                value={form.taskOpacity}
                onChange={(e) => patch({ taskOpacity: Number(e.target.value) })}
              />
            </SettingsRow>
          </SettingsSection>
        </div>
      ) : (
        <div className="mt-5">
          <SettingsSection
            title="本空间覆盖"
            desc="该空间当前使用自己的背景设置，覆盖全局外观"
            danger
          >
            <SettingsRow label="清除覆盖" hint="恢复为全局外观">
              <button
                type="button"
                onClick={() => void onClearScope()}
                className={secondaryBtnClass()}
                disabled={saving}
              >
                清除本空间背景
              </button>
            </SettingsRow>
          </SettingsSection>
        </div>
      )}

      <SettingsFooter
        dirty={dirty}
        saving={saving || uploading}
        msg={msg}
        onReset={reset}
      />
    </form>
  );
}
