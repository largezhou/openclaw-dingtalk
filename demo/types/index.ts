/**
 * 钉钉机器人消息类型定义
 * 
 * 注意：钉钉 SDK 类型（如 BatchSendOTOResponse, OrgGroupSendResponse 等）
 * 已在 @alicloud/dingtalk 包中定义，可直接从 SDK 导入使用。
 * 
 * 本文件仅定义 SDK 中没有的类型，如：
 * - Stream 消息相关类型
 * - Webhook API 响应类型
 * - 旧版 oapi 接口类型
 */

// ======================= 会话和消息类型 =======================

// 会话类型
export type ConversationType = '1' | '2'; // 1: 单聊, 2: 群聊

// 消息类型
export type MessageType = 'text' | 'picture' | 'richText' | 'markdown' | 'file' | 'audio' | 'video';

// 文本消息内容
export interface TextContent {
  content: string;
}

// 图片消息内容
export interface PictureContent {
  downloadCode?: string;
  pictureDownloadCode?: string;
}

// @ 配置
export interface AtConfig {
  atUserIds?: string[];
  atMobiles?: string[];
  isAtAll?: boolean;
}

// 机器人消息数据（来自 Stream 回调，SDK 中没有完整定义）
export interface RobotMessageData {
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
  text?: TextContent;
  content?: PictureContent;
  atUsers?: Array<{
    dingtalkId: string;
    staffId?: string;
  }>;
}

// ======================= 回复消息体 =======================

// 回复消息体 - 文本（用于 sessionWebhook）
export interface TextReplyBody {
  msgtype: 'text';
  text: {
    content: string;
  };
  at?: AtConfig;
}

// 回复消息体 - 图片
export interface ImageReplyBody {
  msgtype: 'image';
  image: {
    mediaId: string;
  };
}

// 回复消息体联合类型
export type ReplyBody = TextReplyBody | ImageReplyBody;

// ======================= 旧版 oapi 接口类型 =======================

// 媒体上传响应（旧版 oapi 接口，SDK 中没有）
export interface MediaUploadResponse {
  errcode: number;
  errmsg?: string;
  media_id?: string;
  type?: string;
  created_at?: number;
}

// Webhook 回复响应
export interface WebhookResponse {
  errcode: number;
  errmsg?: string;
}

// ======================= 消息处理结果 =======================

export interface MessageResult {
  status: 'SUCCESS' | 'FAILURE';
}

// 上传媒体结果
export interface UploadMediaResult {
  mediaId: string;
  url: string;
}
