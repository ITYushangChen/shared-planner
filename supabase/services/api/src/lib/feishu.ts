/**
 * 飞书（Lark）自建应用推送封装 —— P0 只做单向推送。
 *
 * 链路：
 *   1. app_id + app_secret → tenant_access_token（内存缓存，7200s 有效）
 *   2. 接收人标识（优先级从高到低）：
 *      open_id（推荐，API 调试台一键复制，无需通讯录权限）
 *      user_id（企业内用户 ID，管理后台可见，无需通讯录权限）
 *      email（需企业邮箱）
 *      手机号 → open_id（需 contact:user.id:readonly，已弃用）
 *   3. 接收人标识 + 交互卡片 → im/v1/messages（需要 im:message 或 im:message:send_as_bot 权限）
 *
 * P1 做按钮回调时，再扩展验签（Encrypt Key / Verification Token）与 card.action.trigger 处理。
 *
 * 另：getFeishuDocRawContent 用于「知识板块」读取飞书云文档正文（docx raw_content）。
 * 需在飞书开放平台后台开通 docx:document:readonly 权限后方可调用。
 */

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

type TenantTokenResponse = {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
};

type BatchGetIdResponse = {
  code: number;
  msg: string;
  data?: {
    user_list?: Array<{ mobile?: string; email?: string; user_id?: string }>;
  };
};

type SendMessageResponse = {
  code: number;
  msg: string;
  data?: { message_id?: string };
};

// 内存缓存：tenant_access_token（进程级，够用；expire 7200s，留 5 分钟安全边际）
let tokenCache: { token: string; expireAt: number } | null = null;

async function getTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expireAt > now) return tokenCache.token;

  const res = await fetch(
    `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );

  const body = (await res.json()) as TenantTokenResponse;
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`飞书获取 token 失败(${body.code}): ${body.msg}`);
  }

  const ttlMs = Math.min((body.expire ?? 7200) - 300, 7200) * 1000;
  tokenCache = { token: body.tenant_access_token, expireAt: now + ttlMs };
  return body.tenant_access_token;
}

/** 手机号 → open_id（返回字段名是 user_id，但值是 open_id 类型） */
async function getOpenIdByMobile(
  token: string,
  mobile: string,
): Promise<string> {
  const res = await fetch(
    `${FEISHU_BASE}/contact/v3/users/batch_get_id?user_id_type=open_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mobiles: [mobile] }),
    },
  );

  const body = (await res.json()) as BatchGetIdResponse;
  if (body.code !== 0) {
    throw new Error(`飞书查用户失败(${body.code}): ${body.msg}`);
  }

  const user = body.data?.user_list?.find((u) => u.mobile === mobile);
  if (!user?.user_id) {
    throw new Error(`手机号 ${mobile} 未匹配到飞书用户（确认该号已加入应用可见范围）`);
  }
  return user.user_id;
}

/** 发送交互卡片（receive_id_type 可指定 open_id / user_id / email） */
async function sendCard(
  token: string,
  receiveIdType: string,
  receiveId: string,
  card: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(
    `${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    },
  );

  const body = (await res.json()) as SendMessageResponse;
  if (body.code !== 0) {
    throw new Error(`飞书发消息失败(${body.code}): ${body.msg}`);
  }
  return body.data?.message_id ?? "";
}

/**
 * 一键推送。接收人优先级：open_id → user_id → email → 手机号查 open_id。
 * open_id / user_id 均只需 im:message 权限，绕开 contact:user.id:readonly。
 */
export async function sendDailyPlanCard(params: {
  appId: string;
  appSecret: string;
  openId?: string;
  feishuUserId?: string;
  email?: string;
  mobile?: string;
  card: Record<string, unknown>;
}): Promise<{ message_id: string; receive_id: string }> {
  const token = await getTenantAccessToken(params.appId, params.appSecret);

  let receiveIdType: string;
  let receiveId: string;
  if (params.openId) {
    receiveIdType = "open_id";
    receiveId = params.openId;
  } else if (params.feishuUserId) {
    receiveIdType = "user_id";
    receiveId = params.feishuUserId;
  } else if (params.email) {
    receiveIdType = "email";
    receiveId = params.email;
  } else if (params.mobile) {
    receiveIdType = "open_id";
    receiveId = await getOpenIdByMobile(token, params.mobile);
  } else {
    throw new Error("飞书接收人未配置（open_id / user_id / email / mobile 至少其一）");
  }

  const messageId = await sendCard(token, receiveIdType, receiveId, params.card);
  return { message_id: messageId, receive_id: receiveId };
}

type DocRawContentResponse = {
  code: number;
  msg: string;
  data?: { content?: string };
};

type WikiGetNodeResponse = {
  code: number;
  msg: string;
  data?: {
    node?: { obj_token?: string; obj_type?: string; title?: string };
  };
};

/**
 * 从飞书文档链接解析出 docx 文档 ID（document_id），支持三种链接：
 *   1. /docx/<ID>        —— 云文档直链（旧版分享链接），直接用 ID
 *   2. /wiki/<NODE_TOKEN>—— 知识库链接，需先 get_node 把节点 token 转成 obj_token
 *   3. /docs/<ID>        —— 新版统一链接，token 通常即为文档 ID
 * 其中 wiki 链接还会顺带拿到文档标题（作为知识源默认标题）。
 */
async function resolveDocxDocumentId(
  token: string,
  docUrl: string,
): Promise<{ documentId: string; title?: string }> {
  // 1) docx 直链
  const docxMatch = docUrl.match(/\/docx\/([A-Za-z0-9_-]+)/);
  if (docxMatch) return { documentId: docxMatch[1] };

  // 2) wiki 链接：get_node 转 obj_token（依赖 wiki:node:read 权限）
  const wikiMatch = docUrl.match(/\/wiki\/([A-Za-z0-9_-]+)/);
  if (wikiMatch) {
    const nodeToken = wikiMatch[1];
    const res = await fetch(
      `${FEISHU_BASE}/wiki/v2/spaces/get_node?token=${nodeToken}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await res.json()) as WikiGetNodeResponse;
    if (body.code !== 0) {
      throw new Error(`飞书解析 wiki 链接失败(${body.code}): ${body.msg}`);
    }
    const node = body.data?.node;
    if (!node?.obj_token) {
      throw new Error(
        "飞书 wiki 链接无法解析为文档（确认应用机器人已被添加为该文档协作者）",
      );
    }
    if (node.obj_type && node.obj_type !== "docx") {
      throw new Error(`暂不支持该飞书内容类型（${node.obj_type}），仅支持云文档`);
    }
    return { documentId: node.obj_token, title: node.title };
  }

  // 3) 新版 /docs/ 链接：token 通常即文档 ID，直接按 docx 处理
  const docsMatch = docUrl.match(/\/docs\/([A-Za-z0-9_-]+)/);
  if (docsMatch) return { documentId: docsMatch[1] };

  throw new Error(
    "仅支持飞书文档链接（/docx/、/wiki/ 或 /docs/ 路径）",
  );
}

/**
 * 读取飞书云文档正文（纯文本）。依赖 docx:document:readonly 权限，
 * wiki 链接额外依赖 wiki:node:read 权限，未开通时飞书返回 99991672 / 权限错误，
 * 需在开放平台后台开通并发布版本。
 */
export async function getFeishuDocRawContent(params: {
  appId: string;
  appSecret: string;
  docUrl: string;
}): Promise<{ document_id: string; content: string; title?: string }> {
  const token = await getTenantAccessToken(params.appId, params.appSecret);
  const { documentId, title } = await resolveDocxDocumentId(token, params.docUrl);

  const res = await fetch(
    `${FEISHU_BASE}/docx/v1/documents/${documentId}/raw_content`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const body = (await res.json()) as DocRawContentResponse;
  if (body.code !== 0) {
    throw new Error(`飞书读取文档失败(${body.code}): ${body.msg}`);
  }

  return {
    document_id: documentId,
    content: body.data?.content ?? "",
    title,
  };
}
