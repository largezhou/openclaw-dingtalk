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
  height?: number;
  width?: number;
  extension?: string;
}

// 富文本消息内容 - 单个元素
export interface RichTextElement {
  type?: 'text' | 'picture';  // text 时可能没有 type 字段
  text?: string;              // type 为 text 时
  downloadCode?: string;      // type 为 picture 时
  pictureDownloadCode?: string;  // 图片下载码（备选字段）
  height?: number;
  width?: number;
  extension?: string;
}

// 富文本消息内容
export interface RichTextContent {
  richText: RichTextElement[];
}

// 音频消息内容
export interface AudioContent {
  downloadCode?: string;
  duration?: number;      // 语音时长（毫秒）
  extension?: string;     // 文件扩展名，如 amr
  mediaId?: string;
  recognition?: string;   // 语音转文字结果
}

// 视频消息内容
export interface VideoContent {
  downloadCode?: string;
  duration?: number;      // 视频时长（毫秒）
  extension?: string;     // 文件扩展名，如 mp4
  mediaId?: string;
  videoType?: string;
  width?: number;
  height?: number;
}

// 文件消息内容
export interface FileContent {
  downloadCode?: string;
  fileName?: string;      // 文件名
  fileSize?: number;      // 文件大小（字节）
  extension?: string;     // 文件扩展名
  spaceId?: string;
  mediaId?: string;
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
  // 群聊特有字段
  conversationTitle?: string;       // 群名称（仅群聊）
  openConversationId?: string;      // 群会话 ID（仅群聊，用于主动发消息）
  isAdmin?: boolean;                // 发送者是否群管理员（仅群聊）
  // 文本消息
  text?: TextContent;
  // 图片消息（content 字段）
  content?: PictureContent | RichTextContent | AudioContent | VideoContent | FileContent;
  // atUsers 列表
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

// 回复消息体 - Markdown（用于 sessionWebhook）
export interface MarkdownReplyBody {
  msgtype: 'markdown';
  markdown: {
    title: string;
    text: string;
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
export type ReplyBody = TextReplyBody | MarkdownReplyBody | ImageReplyBody;

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
