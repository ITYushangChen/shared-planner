import crypto from "node:crypto";
import { config } from "../config";

/**
 * 卡片按钮回调的轻量签名。
 *
 * 飞书回调是公网可达端点，{todo_id} 又是明文的，所以按钮 value 里带一个
 * HMAC 签名（密钥 = CRON_SECRET，只有服务端知道），回调时校验：
 * 伪造者既不知道 CRON_SECRET，也拿不到郭郭的 open_id 之外的东西。
 *
 * 签名内容含「卡片所属本地日期」：卡片发出去后按钮长期有效，若不绑定日期，
 * 昨天的卡片今天点仍会改状态。绑进来之后，回调侧比对「今天」即可让旧卡失效。
 */

const SIG_LEN = 20;

export function signTodoAction(
  action: string,
  todoId: string,
  date: string,
): string {
  const key = config.cronSecret;
  if (!key) return "";
  return crypto
    .createHmac("sha256", key)
    .update(`${action}:${todoId}:${date}`)
    .digest("hex")
    .slice(0, SIG_LEN);
}

export function verifyTodoAction(
  action: string,
  todoId: string,
  date: string,
  sig: string,
): boolean {
  const expect = signTodoAction(action, todoId, date);
  if (!expect || !sig) return false;
  const a = Buffer.from(expect);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 卡片「改期」动作签名：field = "start" | "end"。
 * 与 done/undo 共用同一 HMAC，动作串拼成 `mv:start` / `mv:end`，
 * 绑定 todoId + 卡片日期，验签侧用 verifyTodoAction 原样反算即可。
 */
export function signRescheduleAction(
  field: "start" | "end",
  todoId: string,
  date: string,
): string {
  return signTodoAction(`mv:${field}`, todoId, date);
}
