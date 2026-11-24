import { Router } from "express";
import { config } from "../config";
import { verifyTodoAction } from "../lib/card-sign";
import { dayBounds } from "../lib/day-bounds";
import {
  buildCard,
  getUserTimezone,
  loadPlanCardSnapshot,
  parsePickerDatetime,
} from "../lib/plan-card";
import { createAdminClient } from "../lib/supabase";

/**
 * 飞书「卡片回传交互」回调（card.action.trigger）。
 *
 * 公网入口：https://diary-service.top/api/feishu/card-callback
 *   （Caddy 是 handle_path /api/*，会剥掉 /api 前缀，所以这里挂 /feishu/card-callback）
 *
 * 要做四件事：
 *  1. 应答开放平台保存请求地址时发的 url_verification（原样回 challenge）
 *  2. 验签：按钮 value 里的 HMAC（密钥 CRON_SECRET）+ 操作人 open_id 白名单
 *  3. 写库：todos.status = done/todo，顺带同步 study_plan_items.status
 *  4. 回卡片：toast + 重建整张卡片（点了立刻能看到 ✅ 变成 ◻️/❗️）
 *
 * 未配 FEISHU_VERIFICATION_TOKEN 也能跑 —— HMAC + open_id 白名单已经是硬门槛。
 * 但若在飞书后台开了 Encrypt Key，body 会整体加密，此路由会明确报错让人关掉。
 */
export const feishuCardRouter = Router();

/** 便于浏览器/curl 直接确认公网链路通不通（不参与业务） */
feishuCardRouter.get("/feishu/card-callback", (_req, res) => {
  res.json({
    ok: true,
    endpoint: "feishu card.action.trigger",
    hint: "把此地址填到飞书开放平台「事件与回调 → 事件配置 → 请求地址」",
  });
});

feishuCardRouter.post("/feishu/card-callback", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, any>;

  // 入口留痕：飞书排查「点击没反应」时唯一可用的观测点。
  // 记录 UA / 事件类型 / 顶层键，静默忽略的分支也要打，否则事后无法区分
  // 「飞书没发」和「发了被我忽略」。
  {
    const ua = String(req.headers["user-agent"] ?? "");
    const et = body.header?.event_type ?? body.type ?? "-";
    console.log(
      `[feishu-callback] IN ip=${req.ip} ua=${ua.slice(0, 60)} event_type=${et} keys=${Object.keys(body).join(",")}`,
    );
  }

  // 0) 请求体解析兜底（express.json 失败时会走到这里才没有 body）
  if (!req.body || typeof req.body !== "object") {
    console.warn("[feishu-callback] 请求体不是 JSON 对象，已忽略");
    res.json({ ok: true });
    return;
  }

  // 1) 请求地址校验
  if (body.type === "url_verification" || typeof body.challenge === "string") {
    if (config.feishuVerificationToken && body.token && body.token !== config.feishuVerificationToken) {
      res.status(401).json({ error: "verification token 不匹配" });
      return;
    }
    res.json({ challenge: body.challenge });
    return;
  }

  // 2) 加密回调：需要 Encrypt Key 才能解密，本项目不启用
  if (typeof body.encrypt === "string") {
    console.warn("[feishu-callback] 收到加密回调（Encrypt Key 已开启），无法处理");
    res.status(400).json({
      error: "回调已加密：请在飞书后台「事件与回调 → 加密策略」清空 Encrypt Key 后重试",
    });
    return;
  }

  // 3) 事件类型白名单（未订阅时会收到别的事件，直接忽略）
  const eventType = body.header?.event_type ?? body.type ?? "";
  if (eventType && eventType !== "card.action.trigger" && eventType !== "card_action_trigger") {
    console.log(`[feishu-callback] 忽略非卡片回调事件: ${eventType}`);
    res.json({ ok: true, ignored: eventType });
    return;
  }

  // 4) 验签（可配）+ 操作人白名单
  const token: string = body.header?.token ?? body.token ?? "";
  if (config.feishuVerificationToken && token && token !== config.feishuVerificationToken) {
    res.status(401).json({ error: "verification token 不匹配" });
    return;
  }

  const operatorOpenId: string = body.event?.operator?.open_id ?? "";
  if (config.feishuReceiverOpenId && operatorOpenId !== config.feishuReceiverOpenId) {
    console.warn("[feishu-callback] 拒绝非白名单操作人:", operatorOpenId);
    res.status(403).json({ error: "操作人不在白名单" });
    return;
  }

  const action = body.event?.action ?? body.action ?? {};
  const value = (action.value ?? {}) as Record<string, any>;
  const act = String(value.a ?? "");
  const todoId = String(value.t ?? "");
  const day = String(value.d ?? "");
  const sig = String(value.s ?? "");
  const field = String(value.f ?? ""); // 仅 mv 使用：start | end

  const isToggle = act === "done" || act === "undo";
  const isMove = act === "mv";
  if ((!isToggle && !isMove) || !todoId) {
    res.json({ toast: { type: "error", content: "回调参数不完整，已忽略" } });
    return;
  }
  if (isMove && field !== "start" && field !== "end") {
    res.json({ toast: { type: "error", content: "改期方向不合法，已忽略" } });
    return;
  }

  // 没有 d = 日期锁定上线前发出的旧卡片：不验签直接拒（不写库，无风险）
  if (!day) {
    console.log(`[feishu-callback] 旧版卡片（无日期）已拒绝: ${todoId}`);
    res.json({
      toast: {
        type: "warning",
        content: "⏳ 这张卡片是旧版本发出的，按钮已失效。请用今天新推的卡片。",
      },
    });
    return;
  }

  // 签名动作串：done/undo 用 act，mv 用 `mv:start` / `mv:end`
  const signAction = isMove ? `mv:${field}` : act;
  if (!verifyTodoAction(signAction, todoId, day, sig)) {
    console.warn("[feishu-callback] 签名校验失败:", { act, todoId, day, field });
    res.status(401).json({ error: "签名校验失败" });
    return;
  }

  try {
    const admin = createAdminClient();

    // 只允许当天点击：按用户时区算「今天」，与卡片里的 d 比对
    const timezone = await getUserTimezone(admin, config.feishuReceiverUserId);
    const todayLocal = dayBounds(timezone).localDate;
    if (day !== todayLocal) {
      console.log(
        `[feishu-callback] 卡片已过期 day=${day} today=${todayLocal} todo=${todoId}`,
      );
      res.json({
        toast: {
          type: "warning",
          content: `⏳ 卡片已过期（${day}），仅当天可点。请用今天新推的卡片。`,
        },
      });
      return;
    }

    if (isToggle) {
      // 写 todos：完成 / 撤销
      const nextStatus = act === "done" ? "done" : "todo";
      const { data: updated, error } = await admin
        .from("todos")
        .update({ status: nextStatus })
        .eq("id", todoId)
        .select("id, title, status");
      if (error) throw new Error(error.message);
      if (!updated || updated.length === 0) throw new Error("待办不存在或无权修改");

      // 顺带同步学习块状态（前端「我的计划」两种口径都能读到一致结果）
      const { error: itemErr } = await admin
        .from("study_plan_items")
        .update({ status: act === "done" ? "done" : "pending" })
        .eq("todo_id", todoId);
      if (itemErr) {
        console.warn("[feishu-callback] study_plan_items 同步失败:", itemErr.message);
      }

      console.log(
        `[feishu-callback] ${act === "done" ? "完成" : "撤销"} ${todoId} ${updated[0].title}`,
      );
    } else {
      // ---- 改期：读 picker_datetime 回传的选中时间 ----
      // 独立 picker 的选中值在 event.action.option（"yyyy-MM-dd HH:mm +0800"）
      const option = String(action.option ?? "");
      const iso = option ? parsePickerDatetime(option, timezone) : null;
      if (!iso) {
        console.warn(`[feishu-callback] 未解析到改期时间 option="${option}"`);
        res.json({ toast: { type: "error", content: "未读取到选择的时间，请重新选择。" } });
        return;
      }

      // 改 todos 的 start_at / end_at
      const col = field === "start" ? "start_at" : "end_at";
      const { data: updated, error } = await admin
        .from("todos")
        .update({ [col]: iso })
        .eq("id", todoId)
        .select("id, title, start_at, end_at");
      if (error) throw new Error(error.message);
      if (!updated || updated.length === 0) throw new Error("待办不存在或无权修改");

      // 顺带同步学习块排期（若该 todo 关联学习块）
      const spiCol = field === "start" ? "scheduled_start" : "scheduled_end";
      const { error: itemErr } = await admin
        .from("study_plan_items")
        .update({ [spiCol]: iso })
        .eq("todo_id", todoId);
      if (itemErr) {
        console.warn("[feishu-callback] study_plan_items 同步失败:", itemErr.message);
      }

      console.log(
        `[feishu-callback] 改期 ${field} ${todoId} ${updated[0].title} -> ${iso}`,
      );
    }

    // 重建卡片（失败不影响写库结果，至少给 toast）
    let card: Record<string, unknown> | null = null;
    try {
      const snap = await loadPlanCardSnapshot(admin, config.feishuReceiverUserId);
      card = buildCard({
        localDate: snap.localDate,
        timezone: snap.timezone,
        today: snap.today,
        future: [],
        skippedCount: 0,
        study: snap.study,
        webBaseUrl: config.webBaseUrl,
        rebuild: true,
      });
    } catch (e) {
      console.warn(
        "[feishu-callback] 重建卡片失败:",
        e instanceof Error ? e.message : e,
      );
    }

    const resp: Record<string, unknown> = {
      toast: {
        type: "success",
        content: isToggle
          ? act === "done"
            ? "✅ 已标记完成"
            : "↩️ 已撤销完成"
          : `🕒 已改期（${field === "start" ? "开始" : "结束"}）`,
      },
    };
    if (card) resp.card = { type: "raw", data: card };

    res.json(resp);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[feishu-callback] 处理失败:", message);
    res.json({ toast: { type: "error", content: `处理失败：${message}` } });
  }
});
