import { z } from "zod";

// ======================= DingTalk Config Schema =======================

/** 群聊策略 */
export type DingTalkGroupPolicy = "open" | "allowlist" | "disabled";

/** 单个群组的独立配置 Schema */
export const DingTalkGroupConfigSchema = z.object({
  /** 工具策略 */
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  /** 是否启用该群 */
  enabled: z.boolean().optional(),
  /** 群内发送者白名单 */
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  /** 群级系统提示词 */
  systemPrompt: z.string().optional(),
}).strict();

export type DingTalkGroupConfig = z.infer<typeof DingTalkGroupConfigSchema>;

/**
 * 钉钉渠道配置 Schema（单账户）
 */
export const DingTalkConfigSchema = z.object({
  /** 是否启用钉钉渠道 */
  enabled: z.boolean().optional(),
  /** 账户名称 */
  name: z.string().optional(),
  /** 钉钉应用 AppKey */
  clientId: z.string().optional(),
  /** 钉钉应用 AppSecret */
  clientSecret: z.string().optional(),
  /** 允许的发送者白名单（单聊），默认 ["*"] 允许所有人 */
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  /** 群聊策略：open=允许所有群, allowlist=白名单, disabled=禁止群聊 */
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  /** 群聊白名单（openConversationId 列表），groupPolicy=allowlist 时生效 */
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  /** 按群 ID 的独立配置 */
  groups: z.record(z.string(), DingTalkGroupConfigSchema).optional(),
});

export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;

// ======================= Resolved Account Type =======================

/**
 * 解析后的钉钉账户配置
 */
export interface ResolvedDingTalkAccount {
  /** 账户 ID（固定为 default） */
  accountId: string;
  /** 账户名称 */
  name?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 钉钉应用 AppKey */
  clientId: string;
  /** 钉钉应用 AppSecret */
  clientSecret: string;
  /** Token 来源 */
  tokenSource: "config" | "none";
  /** 允许的发送者白名单（单聊），默认 ["*"] 允许所有人 */
  allowFrom: Array<string | number>;
  /** 群聊策略 */
  groupPolicy: DingTalkGroupPolicy;
  /** 群聊白名单 */
  groupAllowFrom: Array<string | number>;
  /** 按群 ID 的独立配置 */
  groups: Record<string, DingTalkGroupConfig>;
}

// ======================= Message Types =======================

/**
 * 会话类型
 */
export type ConversationType = "1" | "2"; // 1: 单聊, 2: 群聊

/**
 * 消息类型
 */
export type MessageType = "text" | "picture" | "richText" | "markdown" | "file" | "audio" | "video";

// ======================= 消息内容类型 =======================

/** 图片消息内容 */
export interface PictureContent {
  downloadCode?: string;
  pictureDownloadCode?: string;
  height?: number;
  width?: number;
  extension?: string;
}

/** 音频消息内容 */
export interface AudioContent {
  downloadCode?: string;
  /** 语音时长（秒） */
  duration?: number;
  /** 文件扩展名，如 amr */
  extension?: string;
  mediaId?: string;
  /** 语音转文字结果 */
  recognition?: string;
}

/** 视频消息内容 */
export interface VideoContent {
  downloadCode?: string;
  /** 视频时长（秒） */
  duration?: number;
  /** 文件扩展名，如 mp4 */
  extension?: string;
  mediaId?: string;
  videoType?: string;
  width?: number;
  height?: number;
}

/** 文件消息内容 */
export interface FileContent {
  downloadCode?: string;
  /** 文件名 */
  fileName?: string;
  /** 文件大小（字节） */
  fileSize?: number;
  /** 文件扩展名 */
  extension?: string;
  spaceId?: string;
  mediaId?: string;
}

// ======================= 富文本消息类型 =======================

/** 富文本元素类型 */
export type RichTextElementType = "text" | "picture";

/** 富文本元素 - 文本 */
export interface RichTextTextElement {
  /** 文本元素可能没有 type 字段，或 type 为 "text" */
  type?: "text";
  /** 文本内容 */
  text: string;
}

/** 富文本元素 - 图片 */
export interface RichTextPictureElement {
  type: "picture";
  /** 下载码 */
  downloadCode?: string;
  /** 备选下载码字段 */
  pictureDownloadCode?: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 文件扩展名 */
  extension?: string;
}

/** 富文本元素联合类型 */
export type RichTextElement = RichTextTextElement | RichTextPictureElement;

/** 富文本消息内容 */
export interface RichTextContent {
  richText: RichTextElement[];
}

/** 消息内容联合类型 */
export type MessageContent = PictureContent | AudioContent | VideoContent | FileContent | RichTextContent;

/**
 * 钉钉机器人消息数据（来自 Stream 回调）
 */
export interface DingTalkMessageData {
  conversationId: string;
  conversationType: ConversationType;
  chatbotCorpId: string;
  chatbotUserId: string;
  msgId: string;
  msgtype: MessageType;
  createAt: string;
  senderNick: string;
  senderStaffId: string;
  senderCorpId: string;
  robotCode: string;
  isInAtList: boolean;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: string;
  text?: {
    content: string;
  };
  /** 媒体消息内容（图片、语音、视频、文件） */
  content?: MessageContent;
  atUsers?: Array<{
    dingtalkId: string;
    staffId?: string;
  }>;
  // ---- 群聊特有字段 ----
  /** 群名称（群聊时存在） */
  conversationTitle?: string;
  /** 群会话 ID（群聊时存在，用于主动发消息） */
  openConversationId?: string;
  /** 发送者是否群管理员 */
  isAdmin?: boolean;
}

/**
 * Webhook 响应
 */
export interface WebhookResponse {
  errcode: number;
  errmsg?: string;
}

// ======================= 回复消息体类型 =======================

/** @ 配置 */
export interface AtConfig {
  atUserIds?: string[];
  atMobiles?: string[];
  isAtAll?: boolean;
}

/** 回复消息体 - 文本 */
export interface TextReplyBody {
  msgtype: "text";
  text: {
    content: string;
  };
  at?: AtConfig;
}

/** 回复消息体 - Markdown */
export interface MarkdownReplyBody {
  msgtype: "markdown";
  markdown: {
    title?: string;
    text: string;
  };
  at?: AtConfig;
}

/** 回复消息体联合类型 */
export type ReplyBody = TextReplyBody | MarkdownReplyBody;
