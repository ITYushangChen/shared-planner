import { Router } from "express";
import { z } from "zod";
import { assertSpaceMember } from "../lib/space";
import { createAdminClient } from "../lib/supabase";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";

/**
 * 资料板块：Markdown 文档 / 表格 / 看板 + 附件。
 * 三者同表不同 kind：doc 存 Markdown，table/board 存结构化 JSON（都在 docs.content）。
 * 附件走 storage library 桶直传，后端只登记/查询/删除附件元数据。
 * 挂载于 /docs 下：POST /docs、GET /docs、GET/PATCH/DELETE /docs/:id、
 * POST/GET/DELETE /docs/attachments。
 */

const DOC_SELECT =
  "id, space_id, creator_id, kind, title, content, created_at, updated_at";
const DOC_META_SELECT =
  "id, space_id, creator_id, kind, title, created_at, updated_at";
const ATTACHMENT_SELECT =
  "id, space_id, doc_id, uploader_id, bucket_path, name, size, mime_type, created_at";

const createDocSchema = z.object({
  space_id: z.string().uuid(),
  title: z.string().min(1),
  content: z.string().optional(),
  /** 资料类型：doc=Markdown / table=表格 JSON / board=看板 JSON */
  kind: z.enum(["doc", "table", "board"]).optional(),
});

const updateDocSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
});

const createAttachmentSchema = z.object({
  space_id: z.string().uuid(),
  doc_id: z.string().uuid().nullable().optional(),
  bucket_path: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mime_type: z.string().optional(),
});

/** 更新/删除权限：本人 或 空间 owner/admin（与 RLS 口径一致） */
function canMutate(role: string, creatorId: string, userId: string): boolean {
  return creatorId === userId || role === "owner" || role === "admin";
}

export const docsRouter = Router();

// 1) 创建文档
docsRouter.post("/", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = createDocSchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    const { data, error } = await admin
      .from("docs")
      .insert({
        space_id: body.space_id,
        creator_id: auth.user.id,
        kind: body.kind ?? "doc",
        title: body.title,
        content: body.content ?? "",
      })
      .select(DOC_SELECT)
      .single();

    if (error) throw new Error(error.message);

    res.json({ doc: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 2) 列出空间文档（不含正文，正文只在详情读取）
docsRouter.get("/", requireAuth, async (req, res) => {
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
      .from("docs")
      .select(DOC_META_SELECT)
      .eq("space_id", spaceId)
      .order("updated_at", { ascending: false });

    if (error) throw new Error(error.message);

    res.json({ docs: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 3) 登记附件元数据（文件已由前端直传 storage，这里只落库）
docsRouter.post("/attachments", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const body = createAttachmentSchema.parse(req.body);
    const admin = createAdminClient();
    await assertSpaceMember(admin, body.space_id, auth.user.id);

    const { data, error } = await admin
      .from("attachments")
      .insert({
        space_id: body.space_id,
        doc_id: body.doc_id ?? null,
        uploader_id: auth.user.id,
        bucket_path: body.bucket_path,
        name: body.name,
        size: body.size,
        mime_type: body.mime_type ?? null,
      })
      .select(ATTACHMENT_SELECT)
      .single();

    if (error) throw new Error(error.message);

    res.json({ attachment: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 4) 列出附件（按 space_id，可选 doc_id 过滤）
docsRouter.get("/attachments", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const spaceId = String(req.query.space_id || "");
    if (!spaceId) {
      res.status(400).json({ error: "需要 space_id" });
      return;
    }
    const docId = String(req.query.doc_id || "");

    const admin = createAdminClient();
    await assertSpaceMember(admin, spaceId, auth.user.id);

    let query = admin
      .from("attachments")
      .select(ATTACHMENT_SELECT)
      .eq("space_id", spaceId)
      .order("created_at", { ascending: false });
    if (docId) {
      query = query.eq("doc_id", docId);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ attachments: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 5) 删除附件（元数据 + storage 对象，本人 或 owner/admin）
docsRouter.delete("/attachments/:id", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const attachmentId = String(req.params.id);
    const admin = createAdminClient();

    const { data: existing, error: fetchErr } = await admin
      .from("attachments")
      .select("id, space_id, uploader_id, bucket_path")
      .eq("id", attachmentId)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!existing) throw new Error("附件不存在");

    const member = await assertSpaceMember(admin, existing.space_id, auth.user.id);
    if (!canMutate(member.role, existing.uploader_id, auth.user.id)) {
      throw new Error("无权限删除该附件");
    }

    await admin.storage.from("library").remove([existing.bucket_path]);

    const { error } = await admin
      .from("attachments")
      .delete()
      .eq("id", attachmentId);
    if (error) throw new Error(error.message);

    res.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 6) 文档详情（含正文）
docsRouter.get("/:id", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const docId = String(req.params.id);
    const admin = createAdminClient();

    const { data: doc, error } = await admin
      .from("docs")
      .select(DOC_SELECT)
      .eq("id", docId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!doc) throw new Error("文档不存在");

    await assertSpaceMember(admin, doc.space_id, auth.user.id);

    res.json({ doc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 7) 更新文档（title / content，本人 或 owner/admin）
docsRouter.patch("/:id", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const docId = String(req.params.id);
    const body = updateDocSchema.parse(req.body);
    const admin = createAdminClient();

    const { data: existing, error: fetchErr } = await admin
      .from("docs")
      .select("id, space_id, creator_id")
      .eq("id", docId)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!existing) throw new Error("文档不存在");

    const member = await assertSpaceMember(admin, existing.space_id, auth.user.id);
    if (!canMutate(member.role, existing.creator_id, auth.user.id)) {
      throw new Error("无权限修改该文档");
    }

    const patch: { title?: string; content?: string } = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.content !== undefined) patch.content = body.content;

    const { data, error } = await admin
      .from("docs")
      .update(patch)
      .eq("id", docId)
      .select(DOC_SELECT)
      .single();
    if (error) throw new Error(error.message);

    res.json({ doc: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

// 8) 删除文档（连带附件元数据 + storage 对象，本人 或 owner/admin）
docsRouter.delete("/:id", requireAuth, async (req, res) => {
  try {
    const auth = (req as AuthedRequest).auth!;
    const docId = String(req.params.id);
    const admin = createAdminClient();

    const { data: existing, error: fetchErr } = await admin
      .from("docs")
      .select("id, space_id, creator_id")
      .eq("id", docId)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!existing) throw new Error("文档不存在");

    const member = await assertSpaceMember(admin, existing.space_id, auth.user.id);
    if (!canMutate(member.role, existing.creator_id, auth.user.id)) {
      throw new Error("无权限删除该文档");
    }

    // 清理挂在该文档下的附件 storage 对象（元数据由外键 CASCADE 删除）
    const { data: atts } = await admin
      .from("attachments")
      .select("bucket_path")
      .eq("doc_id", docId);
    const paths = (atts ?? []).map((a) => a.bucket_path as string);
    if (paths.length > 0) {
      await admin.storage.from("library").remove(paths);
    }

    const { error } = await admin.from("docs").delete().eq("id", docId);
    if (error) throw new Error(error.message);

    res.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Not a member") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});
