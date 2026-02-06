import { z } from "zod";

// ======================= DingTalk Config Schema =======================

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
