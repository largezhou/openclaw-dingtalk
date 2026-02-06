import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { DingTalkMessageData, ResolvedDingTalkAccount } from "./types.js";
import { replyViaWebhook, getFileDownloadUrl, downloadFromUrl } from "./client.js";
import { resolveDingTalkAccount } from "./accounts.js";
import { getDingTalkRuntime } from "./runtime.js";
import { logger } from "./logger.js";
import { PLUGIN_ID } from "./constants.js";

// ============================================================================
// 媒体信息类型定义
// ============================================================================

/** 媒体类型枚举（与钉钉消息类型一致） */
export type MediaKind = "picture" | "audio" | "video" | "file";

/** 单个媒体项 */
export interface MediaItem {
  /** 媒体类型 */
  kind: MediaKind;
  /** 本地文件路径 */
  path: string;
  /** MIME 类型 */
  contentType: string;
  /** 文件名（可选） */
  fileName?: string;
  /** 文件大小（字节） */
  fileSize?: number;
  /** 时长（秒，音视频专用） */
  duration?: number;
}

/** 入站消息的媒体上下文 */
export interface InboundMediaContext {
  /** 媒体项列表（支持多媒体混排） */
  items: MediaItem[];
  /** 主媒体（第一个媒体项，兼容旧逻辑） */
  primary?: MediaItem;
}

/** 生成媒体占位符文本 */
function generateMediaPlaceholder(media: InboundMediaContext): string {
  if (media.items.length === 0) return "";

  return media.items
    .map((item) => {
      switch (item.kind) {
        case "picture":
          return "<media:picture>";
        case "audio":
          return `<media:audio${item.duration ? ` duration=${item.duration}s` : ""}>`;
        case "video":
          return `<media:video${item.duration ? ` duration=${item.duration}s` : ""}>`;
        case "file":
          return `<media:file${item.fileName ? ` name="${item.fileName}"` : ""}>`;
        default:
          return `<media:${item.kind}>`;
      }
    })
    .join(" ");
}

/** 从 InboundMediaContext 构建上下文的媒体字段 */
function buildMediaContextFields(media?: InboundMediaContext): Record<string, unknown> {
  if (!media || media.items.length === 0) {
    return {};
  }

  const primary = media.primary ?? media.items[0];

  // 基础字段（兼容旧逻辑，使用主媒体）
  const baseFields: Record<string, unknown> = {
    MediaPath: primary.path,
    MediaType: primary.contentType,
    MediaUrl: primary.path,
  };

  // 如果有多个媒体项，添加扩展字段
  if (media.items.length > 1) {
    baseFields.MediaItems = media.items;
  }

  // 根据主媒体类型添加特定字段
  if (primary.kind === "audio" || primary.kind === "video") {
    if (primary.duration !== undefined) {
      baseFields.MediaDuration = primary.duration;
    }
  }

  if (primary.kind === "file") {
    if (primary.fileName) {
      baseFields.MediaFileName = primary.fileName;
    }
    if (primary.fileSize !== undefined) {
      baseFields.MediaFileSize = primary.fileSize;
    }
  }

  return baseFields;
}

// ============================================================================
// 消息处理器类型定义
// ============================================================================

/** 消息处理结果 */
interface MessageHandleResult {
  /** 是否成功处理 */
  success: boolean;
  /** 媒体上下文（支持多媒体混排） */
  media?: InboundMediaContext;
  /** 错误信息 */
  errorMessage?: string;
  /** 是否需要跳过后续处理 */
  skipProcessing?: boolean;
}

/** 消息处理器接口 */
interface MessageHandler {
  /** 是否能处理该消息类型 */
  canHandle(data: DingTalkMessageData): boolean;
  /** 获取消息预览（用于日志） */
  getPreview(data: DingTalkMessageData): string;
  /** 校验消息 */
  validate(data: DingTalkMessageData): { valid: boolean; errorMessage?: string };
  /** 处理消息 */
  handle(data: DingTalkMessageData, account: ResolvedDingTalkAccount): Promise<MessageHandleResult>;
}

// ============================================================================
// 消息处理器实现
// ============================================================================

/** 文本消息处理器 */
const textMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "text",

  getPreview: (data) => {
    const text = data.text?.content?.trim() ?? "";
    return text.slice(0, 50) + (text.length > 50 ? "..." : "");
  },

  validate: (data) => {
    const text = data.text?.content?.trim() ?? "";
    if (!text) {
      return { valid: false, errorMessage: undefined }; // 空消息静默忽略，不需要回复错误
    }
    return { valid: true };
  },

  handle: async () => {
    // 文本消息不需要预处理，直接返回成功
    return { success: true };
  },
};

/** 图片消息处理器 */
const pictureMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "picture",

  getPreview: () => "[图片]",

  validate: (data) => {
    const downloadCode = data.content?.downloadCode;
    if (!downloadCode) {
      return { valid: false, errorMessage: "图片处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const downloadCode = data.content?.downloadCode!;
    const saved = await downloadAndSaveImage(downloadCode, account);

    if (!saved) {
      return { success: false, errorMessage: "图片处理失败，请稍后重试" };
    }

    // 构建媒体上下文
    const mediaItem: MediaItem = {
      kind: "picture",
      path: saved.path,
      contentType: saved.contentType,
    };

    return {
      success: true,
      media: {
        items: [mediaItem],
        primary: mediaItem,
      },
    };
  },
};

/** 不支持的消息类型处理器 */
const unsupportedMessageHandler: MessageHandler = {
  canHandle: () => true, // 作为兜底处理器

  getPreview: (data) => `[${data.msgtype}]`,

  validate: () => ({
    valid: false,
    errorMessage: "暂不支持该类型消息，请发送文本或图片消息。",
  }),

  handle: async () => {
    return { success: false, skipProcessing: true };
  },
};

/** 消息处理器注册表（按优先级排序） */
const messageHandlers: MessageHandler[] = [
  textMessageHandler,
  pictureMessageHandler,
  unsupportedMessageHandler, // 兜底处理器必须放在最后
];

/** 获取消息处理器 */
function getMessageHandler(data: DingTalkMessageData): MessageHandler {
  return messageHandlers.find((h) => h.canHandle(data))!;
}

/** 通过 webhook 发送错误回复（静默失败） */
function replyError(webhook: string | undefined, message: string | undefined): void {
  if (!webhook || !message) return;
  replyViaWebhook(webhook, message).catch((err) => {
    logger.error("回复错误提示失败:", err);
  });
}

export interface MonitorOptions {
  clientId: string;
  clientSecret: string;
  accountId: string;
  config: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}

export interface MonitorResult {
  account: ResolvedDingTalkAccount;
  stop: () => void;
}

// Track runtime state in memory
const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getDingTalkRuntimeState(accountId: string) {
  return runtimeState.get(`${PLUGIN_ID}:${accountId}`);
}

/**
 * 下载钉钉图片并保存到本地
 * @param downloadCode - 图片下载码
 * @param account - 钉钉账户配置
 * @returns 保存的媒体信息
 */
async function downloadAndSaveImage(
  downloadCode: string,
  account: ResolvedDingTalkAccount
): Promise<{ path: string; contentType: string } | undefined> {
  const pluginRuntime = getDingTalkRuntime();

  try {
    // 1. 获取下载链接
    const downloadUrl = await getFileDownloadUrl(downloadCode, account);
    logger.log("获取图片下载链接成功");

    // 2. 下载图片
    const buffer = await downloadFromUrl(downloadUrl);
    logger.log(`下载图片成功，大小: ${(buffer.length / 1024).toFixed(2)} KB`);

    // 3. 使用 OpenClaw 的 media 工具保存图片
    // contentType 传 undefined，让 OpenClaw 自动检测
    const saved = await pluginRuntime.channel.media.saveMediaBuffer(
      buffer,
      undefined,
      "inbound"
    );

    logger.log(`图片已保存到: ${saved.path}`);
    return {
      path: saved.path,
      contentType: saved.contentType ?? "image/png",
    };
  } catch (err) {
    logger.error("下载或保存图片失败:", err);
    return undefined;
  }
}

/**
 * 启动钉钉 Stream 监听器
 */
export function monitorDingTalkProvider(options: MonitorOptions): MonitorResult {
  const { clientId, clientSecret, accountId, config, abortSignal } = options;
  const pluginRuntime = getDingTalkRuntime();

  const account = resolveDingTalkAccount({ cfg: config, accountId });

  // Record starting state
  recordChannelRuntimeState({
    channel: PLUGIN_ID,
    accountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  // 创建钉钉 Stream 客户端
  const client = new DWClient({
    clientId,
    clientSecret,
    debug: false,
  });

  // ============================================================================
  // 消息处理核心逻辑
  // ============================================================================

  /** 构建发送者信息 */
  const buildSenderInfo = (data: DingTalkMessageData) => {
    const senderId = data.senderStaffId;
    const senderName = data.senderNick;
    const chatId = senderId; // 单聊用 senderId 作为 chatId

    return {
      senderId,
      senderName,
      chatId,
      fromAddress: `${PLUGIN_ID}:${senderId}`,
      toAddress: `${PLUGIN_ID}:${senderId}`,
      label: senderName || senderId,
    };
  };

  /** 构建消息体内容 */
  const buildMessageBody = (data: DingTalkMessageData, media?: InboundMediaContext) => {
    const textContent = data.text?.content?.trim() ?? "";
    const mediaPlaceholder = media ? generateMediaPlaceholder(media) : "";

    // 优先使用文本内容，如果没有则使用媒体占位符
    const rawBody = textContent || mediaPlaceholder;

    return { textContent, rawBody };
  };

  /** 构建入站消息上下文 */
  const buildInboundContext = (
    data: DingTalkMessageData,
    sender: ReturnType<typeof buildSenderInfo>,
    rawBody: string,
    media?: InboundMediaContext
  ) => {
    // 解析路由
    const route = pluginRuntime.channel.routing.resolveAgentRoute({
      cfg: config,
      channel: PLUGIN_ID,
      accountId,
      peer: { kind: "dm", id: sender.chatId },
    });

    // 格式化入站消息体
    const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(config);
    const body = pluginRuntime.channel.reply.formatInboundEnvelope({
      channel: "DingTalk",
      from: sender.label,
      timestamp: parseInt(data.createAt),
      body: rawBody,
      chatType: "direct",
      sender: {
        id: sender.senderId,
        name: sender.senderName,
      },
      envelope: envelopeOptions,
    });

    // 构建基础上下文
    const baseContext = {
      Body: body,
      RawBody: rawBody,
      CommandBody: rawBody,
      From: sender.fromAddress,
      To: sender.toAddress,
      SessionKey: route.sessionKey,
      AccountId: accountId,
      ChatType: "direct" as const,
      ConversationLabel: sender.label,
      SenderId: sender.senderId,
      SenderName: sender.senderName,
      Provider: PLUGIN_ID,
      Surface: PLUGIN_ID,
      MessageSid: data.msgId,
      Timestamp: parseInt(data.createAt),
      WasMentioned: data.isInAtList,
      OriginatingChannel: PLUGIN_ID,
      OriginatingTo: sender.toAddress,
    };

    // 合并媒体字段
    const mediaFields = buildMediaContextFields(media);

    return pluginRuntime.channel.reply.finalizeInboundContext({
      ...baseContext,
      ...mediaFields,
    });
  };

  /** 创建回复分发器 */
  const createReplyDispatcher = (data: DingTalkMessageData) => ({
    deliver: async (payload: { text?: string }) => {
      const replyText = payload.text ?? "";
      if (!replyText) return;

      if (data.sessionWebhook) {
        const result = await replyViaWebhook(data.sessionWebhook, replyText);
        if (result.errcode !== 0) {
          throw new Error(`回复失败: ${result.errmsg}`);
        }
      } else {
        logger.warn("sessionWebhook 不存在，无法回复消息");
      }

      recordChannelRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: { lastOutboundAt: Date.now() },
      });
    },
    onError: (err: unknown, info: { kind: string }) => {
      logger.error(`${info.kind} reply failed:`, err);
    },
  });

  /** 异步处理消息（不阻塞钉钉响应） */
  const processMessageAsync = async (
    data: DingTalkMessageData,
    media?: InboundMediaContext
  ) => {
    try {
      // 1. 构建发送者信息
      const sender = buildSenderInfo(data);

      // 2. 构建消息体
      const { rawBody } = buildMessageBody(data, media);

      // 3. 构建入站上下文
      const ctxPayload = buildInboundContext(data, sender, rawBody, media);

      // 4. 分发消息给 OpenClaw
      const { queuedFinal } = await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: createReplyDispatcher(data),
        replyOptions: {},
      });

      if (!queuedFinal) {
        logger.log(`no response generated for message from ${sender.label}`);
      }
    } catch (error) {
      logger.error("异步处理消息出错:", error);
      recordChannelRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: {
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  // 处理消息的回调函数（立即返回成功，异步处理）
  const handleMessage = async (message: DWClientDownStream) => {
    try {
      const data = JSON.parse(message.data) as DingTalkMessageData;

      // 只处理单聊消息
      if (data.conversationType === "2") {
        logger.log(`收到群聊消息，暂不支持群聊，忽略`);
        client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });
        return;
      }

      // 获取消息处理器
      const handler = getMessageHandler(data);

      // 打印收到的消息信息（单行格式）
      const preview = handler.getPreview(data);
      logger.log(`收到消息 | 单聊 | ${data.senderNick}(${data.senderStaffId}) | ${preview}`);

      // 记录入站活动
      recordChannelRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: { lastInboundAt: Date.now() },
      });

      // 立即返回成功响应给钉钉服务器，避免超时
      client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });

      // 校验消息
      const validation = handler.validate(data);
      if (!validation.valid) {
        replyError(data.sessionWebhook, validation.errorMessage);
        return;
      }

      // 异步处理消息
      handler.handle(data, account)
        .then((result) => {
          if (!result.success) {
            replyError(data.sessionWebhook, result.errorMessage);
            return;
          }
          if (result.skipProcessing) {
            return;
          }
          // 分发消息给 OpenClaw
          return processMessageAsync(data, result.media);
        })
        .catch((err) => {
          logger.error(`处理 ${data.msgtype} 消息失败:`, err);
        });
    } catch (error) {
      logger.error("解析消息出错:", error);
      recordChannelRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: {
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      client.socketCallBackResponse(message.headers.messageId, { status: "FAILURE" });
    }
  };

  // 注册消息监听器
  client.registerCallbackListener(TOPIC_ROBOT, handleMessage);

  // 注册连接事件
  client.on("open", () => {
    logger.log(`[${accountId}] Stream 连接已建立`);
  });

  client.on("close", () => {
    logger.log(`[${accountId}] Stream 连接已关闭`);
    recordChannelRuntimeState({
      channel: PLUGIN_ID,
      accountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  });

  client.on("error", (error: Error) => {
    logger.error(`[${accountId}] Stream 连接错误:`, error);
    recordChannelRuntimeState({
      channel: PLUGIN_ID,
      accountId,
      state: {
        lastError: error.message,
      },
    });
  });

  // 启动连接
  client.connect();

  // 处理中止信号
  const stopHandler = () => {
    logger.log(`[${accountId}] 停止 provider`);
    client.disconnect();
    recordChannelRuntimeState({
      channel: PLUGIN_ID,
      accountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", stopHandler);
  }

  return {
    account,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
