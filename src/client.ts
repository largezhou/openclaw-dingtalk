import * as $OpenApi from "@alicloud/openapi-client";
import * as $Util from "@alicloud/tea-util";
import dingtalk from "@alicloud/dingtalk";
import type { ResolvedDingTalkAccount, WebhookResponse } from "./types.js";

const { oauth2_1_0, robot_1_0 } = dingtalk;

// SDK 客户端类型
type OAuth2Client = InstanceType<typeof oauth2_1_0.default>;
type RobotClient = InstanceType<typeof robot_1_0.default>;

// ======================= Access Token 缓存 =======================

interface TokenCache {
  token: string;
  expireTime: number;
}

const tokenCacheMap = new Map<string, TokenCache>();

/**
 * 创建 OAuth2 客户端
 */
function createOAuth2Client(): OAuth2Client {
  const config = new $OpenApi.Config({});
  config.protocol = "https";
  config.regionId = "central";
  return new oauth2_1_0.default(config);
}

/**
 * 创建 Robot 客户端
 */
function createRobotClient(): RobotClient {
  const config = new $OpenApi.Config({});
  config.protocol = "https";
  config.regionId = "central";
  return new robot_1_0.default(config);
}

/**
 * 获取钉钉 access_token
 */
export async function getAccessToken(account: ResolvedDingTalkAccount): Promise<string> {
  const cacheKey = `${account.clientId}`;
  const cached = tokenCacheMap.get(cacheKey);

  // 检查缓存的 token 是否有效（提前5分钟过期）
  if (cached && Date.now() < cached.expireTime - 5 * 60 * 1000) {
    return cached.token;
  }

  const oauth2Client = createOAuth2Client();
  const request = new oauth2_1_0.GetAccessTokenRequest({
    appKey: account.clientId,
    appSecret: account.clientSecret,
  });

  const response = await oauth2Client.getAccessToken(request);

  if (response.body?.accessToken) {
    const token = response.body.accessToken;
    const expireTime = Date.now() + (response.body.expireIn ?? 7200) * 1000;
    tokenCacheMap.set(cacheKey, { token, expireTime });
    return token;
  }

  throw new Error("获取 access_token 失败: 返回结果为空");
}

// ======================= 发送消息 =======================

export interface SendMessageOptions {
  account: ResolvedDingTalkAccount;
  verbose?: boolean;
}

export interface SendMessageResult {
  messageId: string;
  chatId: string;
}

/**
 * 通过 sessionWebhook 回复消息
 */
export async function replyViaWebhook(
  webhook: string,
  content: string,
  options?: {
    atUserIds?: string[];
    isAtAll?: boolean;
  }
): Promise<WebhookResponse> {
  const body = {
    msgtype: "text",
    text: {
      content,
    },
    at: {
      atUserIds: options?.atUserIds ?? [],
      isAtAll: options?.isAtAll ?? false,
    },
  };

  const response = await fetch(webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return (await response.json()) as WebhookResponse;
}

/**
 * 主动发送单聊文本消息给指定用户
 */
export async function sendTextToUser(
  userId: string,
  content: string,
  options: SendMessageOptions
): Promise<SendMessageResult> {
  const accessToken = await getAccessToken(options.account);
  const robotClient = createRobotClient();

  const headers = new robot_1_0.BatchSendOTOHeaders({
    xAcsDingtalkAccessToken: accessToken,
  });

  const msgParam = JSON.stringify({ content });

  const request = new robot_1_0.BatchSendOTORequest({
    robotCode: options.account.clientId,
    userIds: [userId],
    msgKey: "sampleText",
    msgParam,
  });

  const response = await robotClient.batchSendOTOWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({})
  );

  // 从响应中提取 processQueryKey 作为 messageId
  const processQueryKey = response.body?.processQueryKey ?? `dingtalk-${Date.now()}`;

  return {
    messageId: processQueryKey,
    chatId: userId,
  };
}

/**
 * 主动发送群聊文本消息
 */
export async function sendTextToGroup(
  openConversationId: string,
  content: string,
  options: SendMessageOptions
): Promise<SendMessageResult> {
  const accessToken = await getAccessToken(options.account);
  const robotClient = createRobotClient();

  const headers = new robot_1_0.OrgGroupSendHeaders({
    xAcsDingtalkAccessToken: accessToken,
  });

  const msgParam = JSON.stringify({ content });

  const request = new robot_1_0.OrgGroupSendRequest({
    robotCode: options.account.clientId,
    openConversationId,
    msgKey: "sampleText",
    msgParam,
  });

  const response = await robotClient.orgGroupSendWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({})
  );

  const processQueryKey = response.body?.processQueryKey ?? `dingtalk-${Date.now()}`;

  return {
    messageId: processQueryKey,
    chatId: openConversationId,
  };
}

/**
 * 发送文本消息（自动判断单聊/群聊）
 */
export async function sendTextMessage(
  to: string,
  content: string,
  options: SendMessageOptions & {
    conversationType?: "1" | "2";
  }
): Promise<SendMessageResult> {
  // 根据目标格式判断：群聊 ID 通常是 cid 开头
  const isGroup = options.conversationType === "2" || to.startsWith("cid");

  if (isGroup) {
    return sendTextToGroup(to, content, options);
  }
  return sendTextToUser(to, content, options);
}

// ======================= 探测 Bot =======================

export interface DingTalkProbeResult {
  ok: boolean;
  bot?: {
    name?: string;
    robotCode?: string;
  };
  error?: string;
}

/**
 * 探测钉钉机器人状态
 */
export async function probeDingTalkBot(
  account: ResolvedDingTalkAccount,
  _timeoutMs?: number
): Promise<DingTalkProbeResult> {
  try {
    // 尝试获取 access_token 来验证凭据是否有效
    await getAccessToken(account);
    return {
      ok: true,
      bot: {
        robotCode: account.clientId,
        name: account.name,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
