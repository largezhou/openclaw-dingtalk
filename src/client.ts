import * as $OpenApi from "@alicloud/openapi-client";
import * as $Util from "@alicloud/tea-util";
import dingtalk from "@alicloud/dingtalk";
import type { ResolvedDingTalkAccount, WebhookResponse, MarkdownReplyBody, TextReplyBody } from "./types.js";

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
 * 通过 sessionWebhook 回复消息（支持 markdown 格式）
 */
export async function replyViaWebhook(
  webhook: string,
  content: string,
  options?: {
    atUserIds?: string[];
    isAtAll?: boolean;
    /** 使用 markdown 格式发送（默认 true） */
    useMarkdown?: boolean;
  }
): Promise<WebhookResponse> {
  const useMarkdown = options?.useMarkdown ?? true;
  
  let body: TextReplyBody | MarkdownReplyBody;
  
  if (useMarkdown) {
    // 使用 markdown 格式（不传 title）
    body = {
      msgtype: "markdown",
      markdown: {
        text: content,
      },
      at: {
        atUserIds: options?.atUserIds ?? [],
        isAtAll: options?.isAtAll ?? false,
      },
    } as MarkdownReplyBody;
  } else {
    // 使用纯文本格式
    body = {
      msgtype: "text",
      text: {
        content,
      },
      at: {
        atUserIds: options?.atUserIds ?? [],
        isAtAll: options?.isAtAll ?? false,
      },
    };
  }

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
 * 主动发送单聊消息给指定用户（默认使用 markdown 格式）
 */
export async function sendTextMessage(
  userId: string,
  content: string,
  options: SendMessageOptions & {
    /** 使用 markdown 格式发送（默认 true） */
    useMarkdown?: boolean;
  }
): Promise<SendMessageResult> {
  const accessToken = await getAccessToken(options.account);
  const robotClient = createRobotClient();

  const headers = new robot_1_0.BatchSendOTOHeaders({
    xAcsDingtalkAccessToken: accessToken,
  });

  const useMarkdown = options.useMarkdown ?? true;
  
  let msgKey: string;
  let msgParam: string;
  
  if (useMarkdown) {
    // 使用 markdown 格式（不传 title）
    msgKey = "sampleMarkdown";
    msgParam = JSON.stringify({ text: content });
  } else {
    // 使用纯文本格式
    msgKey = "sampleText";
    msgParam = JSON.stringify({ content });
  }

  const request = new robot_1_0.BatchSendOTORequest({
    robotCode: options.account.clientId,
    userIds: [userId],
    msgKey,
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

// ======================= 图片处理 =======================

/**
 * 获取钉钉文件下载链接
 * @param downloadCode - 文件下载码
 * @param account - 钉钉账户配置
 * @returns 下载链接
 */
export async function getFileDownloadUrl(
  downloadCode: string,
  account: ResolvedDingTalkAccount
): Promise<string> {
  const accessToken = await getAccessToken(account);
  const robotClient = createRobotClient();

  const headers = new robot_1_0.RobotMessageFileDownloadHeaders({
    xAcsDingtalkAccessToken: accessToken,
  });

  const request = new robot_1_0.RobotMessageFileDownloadRequest({
    downloadCode,
    robotCode: account.clientId,
  });

  const response = await robotClient.robotMessageFileDownloadWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({})
  );

  if (response.body?.downloadUrl) {
    return response.body.downloadUrl;
  }

  throw new Error("获取下载链接失败: 返回结果为空");
}

/**
 * 从 URL 下载文件
 * @param url - 下载链接
 * @returns 文件内容 Buffer
 */
export async function downloadFromUrl(url: string): Promise<Buffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`下载文件失败: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ======================= 发送图片消息 =======================

export interface UploadMediaResult {
  mediaId: string;
  url: string;
}

/**
 * 上传媒体文件到钉钉（使用旧版 oapi 接口）
 * @param fileBuffer - 文件 Buffer
 * @param fileName - 文件名
 * @param account - 钉钉账户配置
 * @param type - 文件类型：image, voice, video, file
 * @returns 包含 media_id 和公网可访问 URL 的对象
 */
export async function uploadMedia(
  fileBuffer: Buffer,
  fileName: string,
  account: ResolvedDingTalkAccount,
  type = "image"
): Promise<UploadMediaResult> {
  const accessToken = await getAccessToken(account);

  // 使用 FormData 上传
  const formData = new FormData();
  // 将 Buffer 转换为 Uint8Array 以兼容 Blob
  const uint8Array = new Uint8Array(fileBuffer);
  const blob = new Blob([uint8Array], { type: "image/png" });
  formData.append("media", blob, fileName);
  formData.append("type", type);

  const response = await fetch(
    `https://oapi.dingtalk.com/media/upload?access_token=${accessToken}`,
    {
      method: "POST",
      body: formData,
    }
  );

  const result = (await response.json()) as {
    errcode?: number;
    errmsg?: string;
    media_id?: string;
  };

  if (result.errcode === 0 && result.media_id) {
    // 构造公网可访问的 URL
    const photoURL = `https://oapi.dingtalk.com/media/downloadFile?access_token=${accessToken}&media_id=${result.media_id}`;
    return {
      mediaId: result.media_id,
      url: photoURL,
    };
  }

  throw new Error(`上传媒体文件失败: ${result.errmsg ?? JSON.stringify(result)}`);
}

/**
 * 发送单聊图片消息
 * @param userId - 接收者用户 ID
 * @param photoURL - 图片的公网可访问 URL
 * @param options - 发送选项
 */
export async function sendImageMessage(
  userId: string,
  photoURL: string,
  options: SendMessageOptions
): Promise<SendMessageResult> {
  const accessToken = await getAccessToken(options.account);
  const robotClient = createRobotClient();

  const headers = new robot_1_0.BatchSendOTOHeaders({
    xAcsDingtalkAccessToken: accessToken,
  });

  const msgParam = JSON.stringify({ photoURL });

  const request = new robot_1_0.BatchSendOTORequest({
    robotCode: options.account.clientId,
    userIds: [userId],
    msgKey: "sampleImageMsg",
    msgParam,
  });

  const response = await robotClient.batchSendOTOWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({})
  );

  const processQueryKey = response.body?.processQueryKey ?? `dingtalk-img-${Date.now()}`;

  return {
    messageId: processQueryKey,
    chatId: userId,
  };
}
