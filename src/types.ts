import { z } from "zod";

// ======================= DingTalk Config Schema =======================

/**
 * 钉钉账户配置 Schema
 */
export const DingTalkAccountConfigSchema = z.object({
  /** 账户名称 */
  name: z.string().optional(),
  /** 是否启用 */
  enabled: z.boolean().optional(),
  /** 钉钉应用 AppKey (Client ID) */
  clientId: z.string().optional(),
  /** 钉钉应用 AppSecret (Client Secret) */
  clientSecret: z.string().optional(),
  /** 群组配置 */
  groups: z.record(z.string(), z.object({
    requireMention: z.boolean().optional(),
  })).optional(),
});

/**
 * 钉钉渠道配置 Schema
 */
export const DingTalkConfigSchema = z.object({
  /** 是否启用钉钉渠道 */
  enabled: z.boolean().optional(),
  /** 默认账户名称 */
  name: z.string().optional(),
  /** 钉钉应用 AppKey */
  clientId: z.string().optional(),
  /** 钉钉应用 AppSecret */
  clientSecret: z.string().optional(),
  /** 群组配置 */
  groups: z.record(z.string(), z.object({
    requireMention: z.boolean().optional(),
  })).optional(),
  /** 多账户配置 */
  accounts: z.record(z.string(), DingTalkAccountConfigSchema).optional(),
});

export type DingTalkAccountConfig = z.infer<typeof DingTalkAccountConfigSchema>;
export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;

// ======================= Resolved Account Type =======================

/**
 * 解析后的钉钉账户配置
 */
export interface ResolvedDingTalkAccount {
  /** 账户 ID */
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
  /** 账户配置详情 */
  config: {
    groups?: Record<string, { requireMention?: boolean }>;
  };
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
  content?: {
    downloadCode?: string;
    pictureDownloadCode?: string;
  };
  atUsers?: Array<{
    dingtalkId: string;
    staffId?: string;
  }>;
}

/**
 * Webhook 响应
 */
export interface WebhookResponse {
  errcode: number;
  errmsg?: string;
}
