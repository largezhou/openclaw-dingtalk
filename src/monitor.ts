import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { DingTalkMessageData, ResolvedDingTalkAccount, AudioContent, VideoContent, FileContent, PictureContent, RichTextContent, RichTextElement, RichTextPictureElement } from "./types.js";
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

  // 多媒体字段（与 Telegram 保持一致的命名）
  // 即使只有一个媒体也添加这些字段，保持一致性
  if (media.items.length > 0) {
    baseFields.MediaPaths = media.items.map((m) => m.path);
    baseFields.MediaUrls = media.items.map((m) => m.path);
    baseFields.MediaTypes = media.items.map((m) => m.contentType).filter(Boolean);
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
    const content = data.content as PictureContent | undefined;
    const downloadCode = content?.downloadCode ?? content?.pictureDownloadCode;
    if (!downloadCode) {
      return { valid: false, errorMessage: "图片处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as PictureContent;
    const downloadCode = (content?.downloadCode ?? content?.pictureDownloadCode)!;

    try {
      const saved = await downloadAndSaveMedia({
        downloadCode,
        account,
        mediaKind: "picture",
        extension: content?.extension,
      });

      const mediaItem: MediaItem = {
        kind: "picture",
        path: saved.path,
        contentType: saved.contentType,
        fileSize: saved.fileSize,
      };

      return {
        success: true,
        media: { items: [mediaItem], primary: mediaItem },
      };
    } catch (err) {
      logger.error("图片处理失败：", err);
      return { success: false, errorMessage: `图片处理失败：${getErrorMessage(err)}` };
    }
  },
};

/** 语音消息处理器 */
const audioMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "audio",

  getPreview: (data) => {
    const content = data.content as AudioContent | undefined;
    const duration = content?.duration;
    return duration ? `[语音 ${(duration / 1000).toFixed(1)}s]` : "[语音]";
  },

  validate: (data) => {
    const content = data.content as AudioContent | undefined;
    if (!content?.downloadCode) {
      return { valid: false, errorMessage: "语音处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as AudioContent;
    const downloadCode = content.downloadCode!;

    try {
      const saved = await downloadAndSaveMedia({
        downloadCode,
        account,
        mediaKind: "audio",
        extension: content.extension ?? "amr",
      });

      const mediaItem: MediaItem = {
        kind: "audio",
        path: saved.path,
        contentType: saved.contentType,
        fileSize: saved.fileSize,
        duration: content.duration ? content.duration / 1000 : undefined,
      };

      return {
        success: true,
        media: { items: [mediaItem], primary: mediaItem },
      };
    } catch (err) {
      logger.error("语音处理失败：", err);
      return { success: false, errorMessage: `语音处理失败：${getErrorMessage(err)}` };
    }
  },
};

/** 视频消息处理器 */
const videoMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "video",

  getPreview: (data) => {
    const content = data.content as VideoContent | undefined;
    const duration = content?.duration;
    return duration ? `[视频 ${(duration / 1000).toFixed(1)}s]` : "[视频]";
  },

  validate: (data) => {
    const content = data.content as VideoContent | undefined;
    if (!content?.downloadCode) {
      return { valid: false, errorMessage: "视频处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as VideoContent;
    const downloadCode = content.downloadCode!;

    try {
      const saved = await downloadAndSaveMedia({
        downloadCode,
        account,
        mediaKind: "video",
        extension: content.extension ?? "mp4",
      });

      const mediaItem: MediaItem = {
        kind: "video",
        path: saved.path,
        contentType: saved.contentType,
        fileSize: saved.fileSize,
        duration: content.duration ? content.duration / 1000 : undefined,
      };

      return {
        success: true,
        media: { items: [mediaItem], primary: mediaItem },
      };
    } catch (err) {
      logger.error("视频处理失败：", err);
      return { success: false, errorMessage: `视频处理失败：${getErrorMessage(err)}` };
    }
  },
};

/** 文件消息处理器 */
const fileMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "file",

  getPreview: (data) => {
    const content = data.content as FileContent | undefined;
    const fileName = content?.fileName;
    return fileName ? `[文件] ${fileName}` : "[文件]";
  },

  validate: (data) => {
    const content = data.content as FileContent | undefined;
    if (!content?.downloadCode) {
      return { valid: false, errorMessage: "文件处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as FileContent;
    const downloadCode = content.downloadCode!;

    try {
      const saved = await downloadAndSaveMedia({
        downloadCode,
        account,
        mediaKind: "file",
        extension: content.extension,
        fileName: content.fileName,
      });

      const mediaItem: MediaItem = {
        kind: "file",
        path: saved.path,
        contentType: saved.contentType,
        fileSize: saved.fileSize,
        fileName: content.fileName,
      };

      return {
        success: true,
        media: { items: [mediaItem], primary: mediaItem },
      };
    } catch (err) {
      logger.error("文件处理失败：", err);
      return { success: false, errorMessage: `文件处理失败：${getErrorMessage(err)}` };
    }
  },
};

// ============================================================================
// 富文本消息处理辅助函数
// ============================================================================

/** 判断富文本元素是否为图片 */
function isRichTextPicture(element: RichTextElement): element is RichTextPictureElement {
  return element.type === "picture";
}

/** 从富文本元素中提取下载码 */
function getRichTextPictureDownloadCode(element: RichTextPictureElement): string | undefined {
  return element.downloadCode ?? element.pictureDownloadCode;
}

/** 解析富文本内容，提取文本和图片信息 */
function parseRichTextContent(content: RichTextContent): {
  textParts: string[];
  imageInfos: Array<{
    downloadCode: string;
    width?: number;
    height?: number;
    extension?: string;
  }>;
} {
  const textParts: string[] = [];
  const imageInfos: Array<{
    downloadCode: string;
    width?: number;
    height?: number;
    extension?: string;
  }> = [];

  for (const element of content.richText) {
    if (isRichTextPicture(element)) {
      // 图片元素
      const downloadCode = getRichTextPictureDownloadCode(element);
      if (downloadCode) {
        imageInfos.push({
          downloadCode,
          width: element.width,
          height: element.height,
          extension: element.extension,
        });
      }
    } else {
      // 文本元素（type 为 undefined 或 "text"）
      if (element.text) {
        textParts.push(element.text);
      }
    }
  }

  return { textParts, imageInfos };
}

/** 富文本消息处理器 */
const richTextMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "richText",

  getPreview: (data) => {
    const content = data.content as RichTextContent | undefined;
    if (!content?.richText) return "[富文本]";

    const { textParts, imageInfos } = parseRichTextContent(content);
    const textPreview = textParts.join(" ").slice(0, 30);
    const imageCount = imageInfos.length;

    if (textPreview && imageCount > 0) {
      return `[图文] ${textPreview}${textParts.join(" ").length > 30 ? "..." : ""} +${imageCount}图`;
    } else if (textPreview) {
      return `[富文本] ${textPreview}${textParts.join(" ").length > 30 ? "..." : ""}`;
    } else if (imageCount > 0) {
      return `[图文] ${imageCount}张图片`;
    }
    return "[富文本]";
  },

  validate: (data) => {
    const content = data.content as RichTextContent | undefined;
    if (!content?.richText || !Array.isArray(content.richText)) {
      return { valid: false, errorMessage: "富文本消息格式错误" };
    }
    // 至少要有文本或图片
    const { textParts, imageInfos } = parseRichTextContent(content);
    if (textParts.length === 0 && imageInfos.length === 0) {
      return { valid: false, errorMessage: undefined }; // 空消息静默忽略
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as RichTextContent;
    const { textParts, imageInfos } = parseRichTextContent(content);

    try {
      const mediaItems: MediaItem[] = [];

      // 下载并保存所有图片
      for (let i = 0; i < imageInfos.length; i++) {
        const imgInfo = imageInfos[i];
        logger.log(`处理富文本图片 ${i + 1}/${imageInfos.length}...`);

        const saved = await downloadAndSaveMedia({
          downloadCode: imgInfo.downloadCode,
          account,
          mediaKind: "picture",
          extension: imgInfo.extension,
        });

        mediaItems.push({
          kind: "picture",
          path: saved.path,
          contentType: saved.contentType,
          fileSize: saved.fileSize,
        });
      }

      // 构建媒体上下文
      // 对于图文混排，将文本内容存入 data.text 以便后续处理
      // 这里通过修改 data 对象来传递文本内容
      const combinedText = textParts.join("\n").trim();
      if (combinedText) {
        // 将富文本中的文本内容写入 text 字段，以便后续流程使用
        data.text = { content: combinedText };
      }

      const media: InboundMediaContext | undefined = mediaItems.length > 0
        ? { items: mediaItems, primary: mediaItems[0] }
        : undefined;

      return {
        success: true,
        media,
      };
    } catch (err) {
      logger.error("富文本消息处理失败：", err);
      return { success: false, errorMessage: `富文本消息处理失败：${getErrorMessage(err)}` };
    }
  },
};

/** 不支持的消息类型处理器 */
const unsupportedMessageHandler: MessageHandler = {
  canHandle: () => true, // 作为兜底处理器

  getPreview: (data) => `[${data.msgtype}]`,

  validate: () => ({
    valid: false,
    errorMessage: "暂不支持该类型消息，请发送文本、图片、语音、视频、文件或图文混排消息。",
  }),

  handle: async () => {
    return { success: false, skipProcessing: true };
  },
};

/** 消息处理器注册表（按优先级排序） */
const messageHandlers: MessageHandler[] = [
  textMessageHandler,
  pictureMessageHandler,
  audioMessageHandler,
  videoMessageHandler,
  fileMessageHandler,
  richTextMessageHandler,
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

// ============================================================================
// 媒体下载与保存
// ============================================================================

/** 媒体下载保存选项 */
interface DownloadMediaOptions {
  /** 下载码 */
  downloadCode: string;
  /** 账户配置 */
  account: ResolvedDingTalkAccount;
  /** 媒体类型（用于日志） */
  mediaKind: MediaKind;
  /** 文件扩展名（可选，用于确定 MIME 和文件后缀） */
  extension?: string;
  /** 原始文件名（可选，用于保存时保留后缀） */
  fileName?: string;
  /** 强制指定的 contentType */
  contentType?: string;
}

/** 媒体下载保存结果 */
interface DownloadMediaResult {
  path: string;
  contentType: string;
  fileSize: number;
}

/**
 * 下载钉钉媒体文件并保存到本地（通用函数）
 * 失败时直接抛出错误，错误消息可直接展示给用户
 */
async function downloadAndSaveMedia(
  options: DownloadMediaOptions
): Promise<DownloadMediaResult> {
  const { downloadCode, account, mediaKind, fileName } = options;
  const pluginRuntime = getDingTalkRuntime();

  const kindLabel = {
    picture: "图片",
    audio: "语音",
    video: "视频",
    file: "文件",
  }[mediaKind];

  // 1. 获取下载链接
  const downloadUrl = await getFileDownloadUrl(downloadCode, account);
  logger.log(`获取${kindLabel}下载链接成功`);

  // 2. 下载文件
  const buffer = await downloadFromUrl(downloadUrl);
  const sizeStr = buffer.length > 1024 * 1024
    ? `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
    : `${(buffer.length / 1024).toFixed(2)} KB`;
  logger.log(`下载${kindLabel}成功，大小: ${sizeStr}`);

  // 3. 使用 OpenClaw 的 media 工具保存，让 OpenClaw 自己处理文件名和后缀
  const saved = await pluginRuntime.channel.media.saveMediaBuffer(
    buffer,
    undefined, // contentType: 让 OpenClaw 自动检测
    "inbound",
    buffer.length, // maxBytes: 使用实际大小，避免默认 5MB 限制
    fileName // originalFilename: 直接传原始文件名
  );

  logger.log(`${kindLabel}已保存到: ${saved.path}`);
  return {
    path: saved.path,
    contentType: saved.contentType ?? "application/octet-stream",
    fileSize: buffer.length,
  };
}

/** 提取错误消息（不含堆栈） */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * 启动钉钉 Stream 监听器
 */
export function monitorDingTalkProvider(options: MonitorOptions): MonitorResult {
  const { clientId, clientSecret, accountId, config, abortSignal } = options;
  const pluginRuntime = getDingTalkRuntime();

  const account = resolveDingTalkAccount({ cfg: config, accountId });

  /** 检查发送者是否在 allowFrom 白名单中 */
  const isSenderAllowed = (senderId: string): boolean => {
    const allowList = account.allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
    if (allowList.length === 0 || allowList.includes("*")) {
      return true;
    }
    const prefixPattern = new RegExp(`^${PLUGIN_ID}:(?:user:)?`, "i");
    return allowList
      .map((entry) => entry.replace(prefixPattern, ""))
      .includes(senderId);
  };

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
      CommandAuthorized: isSenderAllowed(sender.senderId),
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
      logger.error("处理消息出错:", error);
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
          const errMsg = getErrorMessage(err);
          logger.error(`处理 ${data.msgtype} 消息失败:`, err); // 保留完整错误对象用于日志
          replyError(data.sessionWebhook, `消息处理失败：${errMsg}`);
        });
    } catch (error) {
      const errMsg = getErrorMessage(error);
      logger.error("解析消息出错:", error); // 保留完整错误对象用于日志
      recordChannelRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: {
          lastError: errMsg,
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

  // 启动连接 — 包装 connect 方法，确保所有调用（含 DWClient 内部自动重连）都不会产生 unhandled rejection
  const originalConnect = client.connect.bind(client);
  client.connect = () =>
    originalConnect().catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[${accountId}] DingTalk Stream 连接失败: ${errMsg}`);
      recordChannelRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: {
          running: false,
          lastStopAt: Date.now(),
          lastError: errMsg,
        },
      });
    });

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
