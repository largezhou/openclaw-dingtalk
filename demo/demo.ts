import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 钉钉 SDK
import * as $OpenApi from '@alicloud/openapi-client';
import * as $Util from '@alicloud/tea-util';

// 钉钉 SDK - 从主包导入，通过命名空间访问类型
import dingtalk from '@alicloud/dingtalk';

// 解构出需要的模块
const { oauth2_1_0, robot_1_0 } = dingtalk;

// 本地类型导入（仅包含 SDK 中没有的类型）
import type {
  RobotMessageData,
  MessageResult,
  TextReplyBody,
  MarkdownReplyBody,
  UploadMediaResult,
  MediaUploadResponse,
  WebhookResponse,
  RichTextContent,
  RichTextElement,
  AudioContent,
  VideoContent,
  FileContent,
  PictureContent,
} from './types/index.js';

// 加载环境变量
dotenv.config();

// 获取当前文件目录（ES Module 兼容）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 确保 tmp 目录存在
const TMP_DIR = path.join(__dirname, '..', 'tmp');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  console.log('📁 创建 tmp 目录:', TMP_DIR);
}

// 获取环境变量并进行类型检查
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// 检查必要的环境变量
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ 错误: 请在 .env 文件中配置 CLIENT_ID 和 CLIENT_SECRET');
  console.error('   CLIENT_ID: 钉钉应用的 AppKey');
  console.error('   CLIENT_SECRET: 钉钉应用的 AppSecret');
  process.exit(1);
}

// 经过上面的检查后，这里 CLIENT_ID 和 CLIENT_SECRET 一定存在
const DINGTALK_CLIENT_ID: string = CLIENT_ID;
const DINGTALK_CLIENT_SECRET: string = CLIENT_SECRET;

console.log('🤖 钉钉机器人 Demo 启动中...');
console.log('   使用 Stream 模式');
console.log('   CLIENT_ID:', DINGTALK_CLIENT_ID);

// 创建钉钉 Stream 客户端
const client = new DWClient({
  clientId: DINGTALK_CLIENT_ID,
  clientSecret: DINGTALK_CLIENT_SECRET,
  debug: false, // 设为 true 可查看更多调试信息
});

// ======================= SDK 客户端类型 =======================
// 从 SDK 命名空间提取类型
type OAuth2Client = InstanceType<typeof oauth2_1_0.default>;
type RobotClient = InstanceType<typeof robot_1_0.default>;

// SDK 响应类型别名
type BatchSendOTOResponse = Awaited<ReturnType<RobotClient['batchSendOTO']>>;
type OrgGroupSendResponse = Awaited<ReturnType<RobotClient['orgGroupSend']>>;

// ======================= SDK 客户端 =======================

/**
 * 创建 OAuth2 客户端（不需要 token）
 */
function createOAuth2Client(): OAuth2Client {
  const config = new $OpenApi.Config({});
  config.protocol = 'https';
  config.regionId = 'central';
  return new oauth2_1_0.default(config);
}

/**
 * 创建 Robot 客户端（需要 token）
 */
function createRobotClient(): RobotClient {
  const config = new $OpenApi.Config({});
  config.protocol = 'https';
  config.regionId = 'central';
  return new robot_1_0.default(config);
}

// 缓存 access_token
let cachedAccessToken: string | null = null;
let tokenExpireTime = 0;

// ======================= 定时任务管理 =======================
// 存储用户的定时任务 { userId: intervalId }
const userTimers = new Map<string, NodeJS.Timeout>();

/**
 * 使用 SDK 获取钉钉 access_token
 * @returns access_token
 */
async function getAccessToken(): Promise<string> {
  // 检查缓存的 token 是否有效（提前5分钟过期）
  if (cachedAccessToken && Date.now() < tokenExpireTime - 5 * 60 * 1000) {
    console.log('🔑 使用缓存的 access_token');
    return cachedAccessToken;
  }

  try {
    console.log('\n========== 获取 Access Token ==========');
    const oauth2Client = createOAuth2Client();
    const requestData = {
      appKey: DINGTALK_CLIENT_ID,
      appSecret: DINGTALK_CLIENT_SECRET.substring(0, 4) + '****' // 隐藏敏感信息
    };
    console.log('📤 请求参数:', JSON.stringify(requestData, null, 2));

    const request = new oauth2_1_0.GetAccessTokenRequest({
      appKey: DINGTALK_CLIENT_ID,
      appSecret: DINGTALK_CLIENT_SECRET
    });

    const response = await oauth2Client.getAccessToken(request);

    console.log('📥 响应数据:', JSON.stringify(response.body, null, 2));

    if (response.body?.accessToken) {
      cachedAccessToken = response.body.accessToken;
      // token 有效期通常为 7200 秒（2小时）
      tokenExpireTime = Date.now() + (response.body.expireIn ?? 7200) * 1000;
      console.log('✅ 获取 access_token 成功');
      console.log('   有效期至:', new Date(tokenExpireTime).toLocaleString());
      console.log('========================================\n');
      return cachedAccessToken;
    } else {
      throw new Error('获取 access_token 失败: 返回结果为空');
    }
  } catch (error) {
    const err = error as Error;
    console.error('❌ 获取 access_token 失败:', err.message);
    console.log('========================================\n');
    throw error;
  }
}

/**
 * 使用 SDK 下载机器人接收到的图片/文件
 * @param downloadCode - 文件下载码
 * @param robotCode - 机器人编码
 * @returns 下载链接
 */
async function getFileDownloadUrl(downloadCode: string, robotCode: string): Promise<string> {
  console.log('\n========== 获取文件下载链接 ==========');
  const accessToken = await getAccessToken();
  const robotClient = createRobotClient();

  const requestData = {
    downloadCode,
    robotCode
  };
  console.log('📤 请求参数:', JSON.stringify(requestData, null, 2));

  const headers = new robot_1_0.RobotMessageFileDownloadHeaders({
    xAcsDingtalkAccessToken: accessToken
  });

  const request = new robot_1_0.RobotMessageFileDownloadRequest({
    downloadCode,
    robotCode
  });

  const response = await robotClient.robotMessageFileDownloadWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({})
  );

  console.log('📥 响应数据:', JSON.stringify(response.body, null, 2));

  if (response.body?.downloadUrl) {
    console.log('✅ 获取下载链接成功');
    // 解析 URL 查看有效期等信息
    try {
      const url = new URL(response.body.downloadUrl);
      console.log('   域名:', url.hostname);
      console.log('   路径:', url.pathname);
      const expiresParam = url.searchParams.get('Expires');
      if (expiresParam) {
        const expiresTimestamp = parseInt(expiresParam) * 1000;
        console.log('   链接有效期至:', new Date(expiresTimestamp).toLocaleString());
      }
    } catch {
      // URL 解析失败，忽略
    }
    console.log('========================================\n');
    return response.body.downloadUrl;
  } else {
    console.log('========================================\n');
    throw new Error('获取下载链接失败: 返回结果为空');
  }
}

/**
 * 从 URL 下载文件
 * @param url - 下载链接
 * @returns 文件内容
 */
async function downloadFromUrl(url: string): Promise<Buffer> {
  console.log('\n========== 下载文件 ==========');
  console.log('📤 请求 URL:', url);

  const response = await fetch(url);

  console.log('📥 响应状态:', response.status, response.statusText);
  console.log('   Content-Type:', response.headers.get('content-type'));
  console.log('   Content-Length:', response.headers.get('content-length'), 'bytes');

  if (!response.ok) {
    console.log('========================================\n');
    throw new Error(`下载文件失败: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  console.log('✅ 下载完成, 实际大小:', arrayBuffer.byteLength, 'bytes');
  console.log('========================================\n');
  return Buffer.from(arrayBuffer);
}

/**
 * 保存图片到 tmp 目录
 * @param buffer - 图片数据
 * @param filename - 文件名
 * @returns 保存的文件路径
 */
function saveImageToTmp(buffer: Buffer, filename: string): string {
  const filePath = path.join(TMP_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * 上传媒体文件到钉钉（使用旧版 oapi 接口）
 * @param filePath - 本地文件路径
 * @param type - 文件类型：image, voice, video, file
 * @returns 包含 media_id 和公网可访问 URL 的对象
 */
async function uploadMedia(filePath: string, type = 'image'): Promise<UploadMediaResult> {
  console.log('\n========== 上传媒体文件 ==========');
  const accessToken = await getAccessToken();

  // 读取文件
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  console.log('📤 上传文件:', fileName);
  console.log('   文件大小:', (fileBuffer.length / 1024).toFixed(2), 'KB');

  // 使用 FormData 上传
  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: 'image/png' });
  formData.append('media', blob, fileName);
  formData.append('type', type);

  const response = await fetch(
    `https://oapi.dingtalk.com/media/upload?access_token=${accessToken}`,
    {
      method: 'POST',
      body: formData
    }
  );

  const result = await response.json() as MediaUploadResponse;
  console.log('📥 响应数据:', JSON.stringify(result, null, 2));

  if (result.errcode === 0 && result.media_id) {
    console.log('✅ 上传媒体文件成功');
    console.log('   media_id:', result.media_id);
    // 构造公网可访问的 URL
    const photoURL = `https://oapi.dingtalk.com/media/downloadFile?access_token=${accessToken}&media_id=${result.media_id}`;
    console.log('   photoURL:', photoURL);
    console.log('========================================\n');
    return {
      mediaId: result.media_id,
      url: photoURL
    };
  } else {
    console.log('========================================\n');
    throw new Error(`上传媒体文件失败: ${result.errmsg ?? JSON.stringify(result)}`);
  }
}

/**
 * 使用 SDK 发送单聊图片消息（通过 photoURL）
 * @param userId - 接收者用户 ID
 * @param photoURL - 图片的公网可访问 URL
 * @param robotCode - 机器人编码
 */
async function sendImageToUser(userId: string, photoURL: string, robotCode: string): Promise<BatchSendOTOResponse> {
  console.log('\n========== 发送单聊图片消息 ==========');
  const accessToken = await getAccessToken();
  const robotClient = createRobotClient();

  const headers = new robot_1_0.BatchSendOTOHeaders({
    xAcsDingtalkAccessToken: accessToken
  });

  const msgParam = JSON.stringify({
    photoURL
  });

  const requestData = {
    robotCode,
    userIds: [userId],
    msgKey: 'sampleImageMsg',
    msgParam
  };
  console.log('📤 请求参数:', JSON.stringify(requestData, null, 2));

  const request = new robot_1_0.BatchSendOTORequest({
    robotCode,
    userIds: [userId],
    msgKey: 'sampleImageMsg',
    msgParam
  });

  const response = await robotClient.batchSendOTOWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({})
  );

  console.log('📥 响应数据:', JSON.stringify(response.body, null, 2));
  console.log('✅ 发送单聊图片消息完成');
  console.log('========================================\n');
  return response;
}

/**
 * 使用 SDK 发送群聊图片消息（通过 photoURL）
 * @param openConversationId - 群会话 ID
 * @param photoURL - 图片的公网可访问 URL
 * @param robotCode - 机器人编码
 */
async function sendImageToGroup(openConversationId: string, photoURL: string, robotCode: string): Promise<OrgGroupSendResponse> {
  console.log('\n========== 发送群聊图片消息 ==========');
  const accessToken = await getAccessToken();
  const robotClient = createRobotClient();

  const headers = new robot_1_0.OrgGroupSendHeaders({
    xAcsDingtalkAccessToken: accessToken
  });

  const msgParam = JSON.stringify({
    photoURL
  });

  const requestData = {
    robotCode,
    openConversationId,
    msgKey: 'sampleImageMsg',
    msgParam
  };
  console.log('📤 请求参数:', JSON.stringify(requestData, null, 2));

  const request = new robot_1_0.OrgGroupSendRequest({
    robotCode,
    openConversationId,
    msgKey: 'sampleImageMsg',
    msgParam
  });

  const response = await robotClient.orgGroupSendWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({})
  );

  console.log('📥 响应数据:', JSON.stringify(response.body, null, 2));
  console.log('✅ 发送群聊图片消息完成');
  console.log('========================================\n');
  return response;
}

/**
 * 主动发送单聊文本消息给指定用户（不依赖 sessionWebhook）
 * @param userId - 接收者用户 ID（senderStaffId）
 * @param content - 消息内容
 * @param robotCode - 机器人编码（CLIENT_ID）
 */
async function sendTextToUser(userId: string, content: string, robotCode: string): Promise<BatchSendOTOResponse> {
  console.log('\n========== 主动发送单聊文本消息 ==========');
  const accessToken = await getAccessToken();
  const robotClient = createRobotClient();

  const headers = new robot_1_0.BatchSendOTOHeaders({
    xAcsDingtalkAccessToken: accessToken
  });

  const msgParam = JSON.stringify({
    content
  });

  const requestData = {
    robotCode,
    userIds: [userId],
    msgKey: 'sampleText',
    msgParam
  };
  console.log('📤 请求参数:', JSON.stringify(requestData, null, 2));

  const request = new robot_1_0.BatchSendOTORequest({
    robotCode,
    userIds: [userId],
    msgKey: 'sampleText',
    msgParam
  });

  const response = await robotClient.batchSendOTOWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({})
  );

  console.log('📥 响应数据:', JSON.stringify(response.body, null, 2));
  console.log('✅ 主动发送单聊文本消息完成');
  console.log('========================================\n');
  return response;
}

/**
 * 启动"嘿嘿"定时任务
 * @param userId - 用户 ID
 * @param robotCode - 机器人编码
 */
function startHeiHeiTimer(userId: string, robotCode: string): void {
  // 如果用户已有定时任务，先停止
  const existingTimer = userTimers.get(userId);
  if (existingTimer) {
    console.log(`⏹️  用户 ${userId} 已有定时任务，先停止旧任务`);
    clearInterval(existingTimer);
  }

  console.log(`\n⏰ 启动"嘿嘿"定时任务 - 用户: ${userId}`);
  console.log(`   每 30 秒发送一次"嘿嘿"`);

  // 立即发送一次
  sendTextToUser(userId, '嘿嘿', robotCode).catch((err: Error) => {
    console.error('❌ 发送嘿嘿失败:', err.message);
  });

  // 设置定时任务，每 30 秒执行一次
  const intervalId = setInterval(() => {
    console.log(`\n⏰ [定时任务] 向用户 ${userId} 发送"嘿嘿"`);
    sendTextToUser(userId, '嘿嘿', robotCode).catch((err: Error) => {
      console.error('❌ 定时发送嘿嘿失败:', err.message);
    });
  }, 30 * 1000); // 30秒

  // 保存定时任务 ID
  userTimers.set(userId, intervalId);
  console.log(`✅ 定时任务已启动`);
}

/**
 * 停止用户的"嘿嘿"定时任务
 * @param userId - 用户 ID
 * @returns 是否成功停止
 */
function stopHeiHeiTimer(userId: string): boolean {
  const timer = userTimers.get(userId);
  if (timer) {
    clearInterval(timer);
    userTimers.delete(userId);
    console.log(`⏹️  已停止用户 ${userId} 的"嘿嘿"定时任务`);
    return true;
  }
  return false;
}

/**
 * 处理机器人接收到的消息
 * @param message - 接收到的消息对象
 */
async function handleRobotMessage(message: DWClientDownStream): Promise<MessageResult> {
  try {
    // 解析消息内容
    const data = JSON.parse(message.data) as RobotMessageData;

    console.log('\n##################################################');
    console.log('################## 收到新消息 ##################');
    console.log('##################################################');
    console.log('\n========== 原始消息数据 ==========');
    console.log(JSON.stringify(data, null, 2));
    console.log('========================================\n');

    console.log('📨 消息摘要:');
    console.log('   发送者:', data.senderNick);
    console.log('   发送者ID:', data.senderStaffId);
    console.log('   发送者企业ID:', data.senderCorpId);
    console.log('   会话类型:', data.conversationType === '1' ? '单聊' : '群聊');
    console.log('   会话ID:', data.conversationId);
    console.log('   消息ID:', data.msgId);
    console.log('   消息类型:', data.msgtype);
    console.log('   机器人编码:', data.robotCode);
    console.log('   创建时间:', new Date(parseInt(data.createAt)).toLocaleString());
    console.log('   是否在@列表:', data.isInAtList);
    if (data.sessionWebhook) {
      console.log('   sessionWebhook:', data.sessionWebhook);
      console.log('   webhook过期时间:', new Date(parseInt(data.sessionWebhookExpiredTime ?? '0')).toLocaleString());
    }

    // 处理文本消息
    if (data.msgtype === 'text') {
      const content = data.text?.content?.trim() ?? '';
      console.log('\n📝 文本消息内容:', content);

      const { senderStaffId, robotCode } = data;

      // 检测"嘿嘿"消息，启动定时任务
      if (content === '嘿嘿') {
        console.log('🎯 检测到"嘿嘿"消息，启动定时任务');
        startHeiHeiTimer(senderStaffId, robotCode);

        // 回复用户
        if (data.sessionWebhook) {
          const replyBody: MarkdownReplyBody = {
            msgtype: 'markdown',
            markdown: {
              title: '定时任务已启动',
              text: `## 😄 收到！\n\n我会每 **30 秒** 给你发一次 "嘿嘿"\n\n> 发送 \`停止嘿嘿\` 可以停止`
            },
            at: {
              atUserIds: [senderStaffId],
              isAtAll: false
            }
          };
          await replyMessage(data.sessionWebhook, replyBody);
        }
        return { status: 'SUCCESS' };
      }

      // 检测"停止嘿嘿"消息，停止定时任务
      if (content === '停止嘿嘿') {
        const stopped = stopHeiHeiTimer(senderStaffId);
        
        if (data.sessionWebhook) {
          const replyBody: MarkdownReplyBody = {
            msgtype: 'markdown',
            markdown: {
              title: stopped ? '任务已停止' : '无运行任务',
              text: stopped ? '## ✅ 已停止\n\n"嘿嘿" 定时任务已停止' : '## ⚠️ 提示\n\n你没有正在运行的 "嘿嘿" 任务'
            },
            at: {
              atUserIds: [senderStaffId],
              isAtAll: false
            }
          };
          await replyMessage(data.sessionWebhook, replyBody);
        }
        return { status: 'SUCCESS' };
      }

      // 其他文本消息：使用 markdown 格式回复
      const replyBody: MarkdownReplyBody = {
        msgtype: 'markdown',
        markdown: {
          title: '收到消息',
          text: `## 📨 收到消息\n\n**你说：**\n\n> ${content}`
        },
        at: {
          atUserIds: [senderStaffId],  // @发送者
          isAtAll: false
        }
      };

      // 使用 sessionWebhook 回复消息
      if (data.sessionWebhook) {
        await replyMessage(data.sessionWebhook, replyBody);
        console.log('✅ 已回复消息');
      }
    }

    // 处理图片消息
    if (data.msgtype === 'picture') {
      console.log('\n🖼️ 图片消息详情:');
      console.log('   图片内容:', JSON.stringify(data.content, null, 2));

      const downloadCode = data.content?.downloadCode;
      const { robotCode, conversationType, senderStaffId, conversationId } = data;

      console.log('   下载码:', downloadCode ?? '无');
      console.log('   下载码长度:', downloadCode?.length ?? 0);

      if (downloadCode && robotCode) {
        try {
          console.log('\n🔄 开始处理图片...');

          // 1. 使用 SDK 获取下载链接
          const downloadUrl = await getFileDownloadUrl(downloadCode, robotCode);

          // 2. 从链接下载图片并保存到本地
          const imageBuffer = await downloadFromUrl(downloadUrl);

          // 生成文件名（使用时间戳）
          const timestamp = Date.now();
          const filename = `image_${timestamp}.png`;

          // 3. 保存图片到本地
          const savedPath = saveImageToTmp(imageBuffer, filename);
          console.log('💾 图片已保存到本地:', savedPath);
          console.log('   文件大小:', (imageBuffer.length / 1024).toFixed(2), 'KB');

          // 4. 上传本地图片到钉钉获取公网可访问的 URL
          console.log('\n📤 准备上传本地图片到钉钉...');
          const uploadResult = await uploadMedia(savedPath, 'image');
          const photoURL = uploadResult.url;
          console.log('✅ 上传成功，获取到 photoURL');

          // 5. 使用 markdown 发送图文混排消息（展示各种 markdown 语法）
          console.log('\n📤 准备发送图文混排消息给用户...');
          
          const replyBody: MarkdownReplyBody = {
            msgtype: 'markdown',
            markdown: {
              title: '图片已收到',
              text: [
                '# 一级标题：图片已收到',
                '## 二级标题：处理结果',
                '### 三级标题：详细信息',
                '',
                '---',
                '',
                '> 这是一段引用文字，用于展示引用效果',
                '',
                `![收到的图片](${photoURL})`,
                '',
                '**这是加粗文字** 和 *这是斜体文字*',
                '',
                '#### 表格展示',
                '',
                '| 属性 | 值 |',
                '|---|---|',
                `| 📁 文件名 | \`${filename}\` |`,
                `| 📊 大小 | ${(imageBuffer.length / 1024).toFixed(2)} KB |`,
                '| 📅 时间 | ' + new Date().toLocaleString() + ' |',
                '',
                '#### 无序列表',
                '',
                '- 列表项 1：支持图片',
                '- 列表项 2：支持表格',
                '- 列表项 3：支持各种格式',
                '',
                '#### 有序列表',
                '',
                '1. 第一步：接收图片',
                '2. 第二步：保存到本地',
                '3. 第三步：上传到钉钉',
                '4. 第四步：返回结果',
                '',
                '---',
                '',
                '这是一个 [链接示例](https://open.dingtalk.com)，点击可以跳转',
                '',
                '行内代码：`console.log("Hello DingTalk!")`',
                '',
                '代码块：',
                '```',
                'function hello() {',
                '  return "Hello, World!";',
                '}',
                '```'
              ].join('\n')
            },
            at: {
              atUserIds: [senderStaffId],
              isAtAll: false
            }
          };

          if (data.sessionWebhook) {
            await replyMessage(data.sessionWebhook, replyBody);
          }

        } catch (downloadError) {
          const err = downloadError as Error;
          console.error('\n❌ 处理图片失败:', err.message);
          console.error('   错误堆栈:', err.stack);

          // 通知用户处理失败
          if (data.sessionWebhook) {
            const errorReply: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '图片处理失败',
                text: `## ❌ 图片处理失败\n\n**错误信息：**\n\n\`\`\`\n${err.message}\n\`\`\``
              }
            };
            await replyMessage(data.sessionWebhook, errorReply);
          }
        }
      } else {
        console.log('⚠️  图片消息缺少 downloadCode 或 robotCode');
      }
    }

    // 处理富文本消息（文字+图片混合）
    if (data.msgtype === 'richText') {
      console.log('\n📝🖼️ 富文本消息详情:');
      const richTextContent = data.content as RichTextContent;
      console.log('   内容:', JSON.stringify(richTextContent, null, 2));

      const { robotCode, senderStaffId, conversationType, conversationId } = data;

      if (richTextContent?.richText && robotCode) {
        try {
          console.log('\n🔄 开始处理富文本消息...');

          // 解析富文本内容
          const elements = richTextContent.richText;
          const textParts: string[] = [];
          const imageInfos: { downloadCode: string; width?: number; height?: number; extension?: string }[] = [];

          for (const element of elements) {
            // 文本元素：有 text 字段且没有 type 或 type 为 text
            if (element.text !== undefined && element.type !== 'picture') {
              textParts.push(element.text);
            }
            // 图片元素：type 为 picture
            else if (element.type === 'picture') {
              const downloadCode = element.downloadCode || element.pictureDownloadCode;
              if (downloadCode) {
                imageInfos.push({
                  downloadCode,
                  width: element.width,
                  height: element.height,
                  extension: element.extension
                });
              }
            }
          }

          console.log('   解析结果:');
          console.log('   - 文本部分:', textParts.join(' | ').replace(/\n/g, '\\n'));
          console.log('   - 图片数量:', imageInfos.length);

          // 处理每张图片
          const savedImages: string[] = [];
          for (let i = 0; i < imageInfos.length; i++) {
            const imgInfo = imageInfos[i];
            console.log(`\n🔄 处理第 ${i + 1}/${imageInfos.length} 张图片...`);
            console.log(`   尺寸: ${imgInfo.width ?? '?'}x${imgInfo.height ?? '?'}, 格式: ${imgInfo.extension ?? '未知'}`);

            const downloadUrl = await getFileDownloadUrl(imgInfo.downloadCode, robotCode);
            const imageBuffer = await downloadFromUrl(downloadUrl);
            const timestamp = Date.now();
            const ext = imgInfo.extension ?? 'png';
            const filename = `richtext_image_${timestamp}_${i + 1}.${ext}`;
            const savedPath = saveImageToTmp(imageBuffer, filename);
            savedImages.push(filename);
            console.log(`💾 图片 ${i + 1} 已保存: ${savedPath}`);
          }

          // 回复用户
          const replyText = [
            '## ✅ 收到富文本消息！',
            '',
            '### 📝 文本内容',
            '',
            textParts.length > 0 ? `> ${textParts.join('\n> ')}` : '（无文本）',
            '',
            `### 🖼️ 包含 ${imageInfos.length} 张图片`,
            '',
            ...savedImages.map((name, i) => `${i + 1}. \`${name}\``)
          ].join('\n');

          if (data.sessionWebhook) {
            const replyBody: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '收到富文本消息',
                text: replyText
              },
              at: { atUserIds: [senderStaffId], isAtAll: false }
            };
            await replyMessage(data.sessionWebhook, replyBody);
          }

        } catch (error) {
          const err = error as Error;
          console.error('\n❌ 处理富文本消息失败:', err.message);
          if (data.sessionWebhook) {
            const errorReply: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '富文本处理失败',
                text: `## ❌ 富文本消息处理失败\n\n**错误信息：**\n\n\`\`\`\n${err.message}\n\`\`\``
              }
            };
            await replyMessage(data.sessionWebhook, errorReply);
          }
        }
      }
    }

    // 处理音频消息
    if (data.msgtype === 'audio') {
      console.log('\n🎵 音频消息详情:');
      const audioContent = data.content as AudioContent;
      console.log('   内容:', JSON.stringify(audioContent, null, 2));

      const { robotCode, senderStaffId } = data;
      const downloadCode = audioContent?.downloadCode;
      const duration = audioContent?.duration;
      const extension = audioContent?.extension ?? 'amr';
      const recognition = audioContent?.recognition;

      console.log('   下载码:', downloadCode ?? '无');
      console.log('   时长:', duration ? `${(duration / 1000).toFixed(1)}秒` : '未知');
      console.log('   格式:', extension);
      console.log('   语音转文字:', recognition ?? '（无）');

      if (downloadCode && robotCode) {
        try {
          console.log('\n🔄 开始下载音频...');

          // 获取下载链接并下载
          const downloadUrl = await getFileDownloadUrl(downloadCode, robotCode);
          const audioBuffer = await downloadFromUrl(downloadUrl);

          // 保存到本地
          const timestamp = Date.now();
          const filename = `audio_${timestamp}.${extension}`;
          const savedPath = saveImageToTmp(audioBuffer, filename);
          console.log('💾 音频已保存到本地:', savedPath);
          console.log('   文件大小:', (audioBuffer.length / 1024).toFixed(2), 'KB');

          // 回复用户
          const replyLines = [
            '## ✅ 收到语音消息！',
            '',
            '| 属性 | 值 |',
            '|---|---|',
            `| 📁 文件名 | \`${filename}\` |`,
            `| ⏱️ 时长 | ${duration ? `${(duration / 1000).toFixed(1)}秒` : '未知'} |`,
            `| 📊 大小 | ${(audioBuffer.length / 1024).toFixed(2)} KB |`,
            `| 🎵 格式 | ${extension.toUpperCase()} |`
          ];

          if (recognition) {
            replyLines.push('', '### 🗣️ 语音识别结果', '', `> ${recognition}`);
          }

          if (data.sessionWebhook) {
            const replyBody: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '收到语音消息',
                text: replyLines.join('\n')
              },
              at: { atUserIds: [senderStaffId], isAtAll: false }
            };
            await replyMessage(data.sessionWebhook, replyBody);
          }

        } catch (error) {
          const err = error as Error;
          console.error('\n❌ 处理音频消息失败:', err.message);
          if (data.sessionWebhook) {
            const errorReply: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '音频处理失败',
                text: `## ❌ 音频处理失败\n\n**错误信息：**\n\n\`\`\`\n${err.message}\n\`\`\``
              }
            };
            await replyMessage(data.sessionWebhook, errorReply);
          }
        }
      } else {
        console.log('⚠️  音频消息缺少 downloadCode 或 robotCode');
      }
    }

    // 处理视频消息
    if (data.msgtype === 'video') {
      console.log('\n🎬 视频消息详情:');
      const videoContent = data.content as VideoContent;
      console.log('   内容:', JSON.stringify(videoContent, null, 2));

      const { robotCode, senderStaffId } = data;
      const downloadCode = videoContent?.downloadCode;
      const duration = videoContent?.duration;
      const extension = videoContent?.extension ?? 'mp4';
      const width = videoContent?.width;
      const height = videoContent?.height;
      const videoType = videoContent?.videoType;

      console.log('   下载码:', downloadCode ?? '无');
      console.log('   时长:', duration ? `${(duration / 1000).toFixed(1)}秒` : '未知');
      console.log('   分辨率:', width && height ? `${width}x${height}` : '未知');
      console.log('   格式:', extension);
      console.log('   视频类型:', videoType ?? '未知');

      if (downloadCode && robotCode) {
        try {
          console.log('\n🔄 开始下载视频...');

          // 获取下载链接并下载
          const downloadUrl = await getFileDownloadUrl(downloadCode, robotCode);
          const videoBuffer = await downloadFromUrl(downloadUrl);

          // 保存到本地
          const timestamp = Date.now();
          const filename = `video_${timestamp}.${extension}`;
          const savedPath = saveImageToTmp(videoBuffer, filename);
          console.log('💾 视频已保存到本地:', savedPath);
          console.log('   文件大小:', (videoBuffer.length / 1024 / 1024).toFixed(2), 'MB');

          // 回复用户
          const replyLines = [
            '## ✅ 收到视频消息！',
            '',
            '| 属性 | 值 |',
            '|---|---|',
            `| 📁 文件名 | \`${filename}\` |`,
            `| ⏱️ 时长 | ${duration ? `${(duration / 1000).toFixed(1)}秒` : '未知'} |`,
            `| 📐 分辨率 | ${width && height ? `${width}x${height}` : '未知'} |`,
            `| 📊 大小 | ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB |`,
            `| 🎬 格式 | ${extension.toUpperCase()} |`
          ];

          if (data.sessionWebhook) {
            const replyBody: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '收到视频消息',
                text: replyLines.join('\n')
              },
              at: { atUserIds: [senderStaffId], isAtAll: false }
            };
            await replyMessage(data.sessionWebhook, replyBody);
          }

        } catch (error) {
          const err = error as Error;
          console.error('\n❌ 处理视频消息失败:', err.message);
          if (data.sessionWebhook) {
            const errorReply: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '视频处理失败',
                text: `## ❌ 视频处理失败\n\n**错误信息：**\n\n\`\`\`\n${err.message}\n\`\`\``
              }
            };
            await replyMessage(data.sessionWebhook, errorReply);
          }
        }
      } else {
        console.log('⚠️  视频消息缺少 downloadCode 或 robotCode');
      }
    }

    // 处理文件消息
    if (data.msgtype === 'file') {
      console.log('\n📄 文件消息详情:');
      const fileContent = data.content as FileContent;
      console.log('   内容:', JSON.stringify(fileContent, null, 2));

      const { robotCode, senderStaffId } = data;
      const downloadCode = fileContent?.downloadCode;
      const fileName = fileContent?.fileName ?? 'unknown_file';
      const fileSize = fileContent?.fileSize;
      const extension = fileContent?.extension ?? '';

      console.log('   下载码:', downloadCode ?? '无');
      console.log('   文件名:', fileName);
      console.log('   大小:', fileSize ? `${(fileSize / 1024).toFixed(2)} KB` : '未知');
      console.log('   扩展名:', extension || '无');

      if (downloadCode && robotCode) {
        try {
          console.log('\n🔄 开始下载文件...');

          // 获取下载链接并下载
          const downloadUrl = await getFileDownloadUrl(downloadCode, robotCode);
          const fileBuffer = await downloadFromUrl(downloadUrl);

          // 保存到本地（使用原始文件名，加时间戳避免冲突）
          const timestamp = Date.now();
          const savedFileName = `${timestamp}_${fileName}`;
          const savedPath = saveImageToTmp(fileBuffer, savedFileName);
          console.log('💾 文件已保存到本地:', savedPath);
          console.log('   实际大小:', (fileBuffer.length / 1024).toFixed(2), 'KB');

          // 回复用户
          const replyLines = [
            '## ✅ 收到文件！',
            '',
            '| 属性 | 值 |',
            '|---|---|',
            `| 📁 原始文件名 | \`${fileName}\` |`,
            `| 💾 保存为 | \`${savedFileName}\` |`,
            `| 📊 大小 | ${(fileBuffer.length / 1024).toFixed(2)} KB |`,
            `| 📝 类型 | ${extension.toUpperCase() || '未知'} |`
          ];

          if (data.sessionWebhook) {
            const replyBody: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '收到文件',
                text: replyLines.join('\n')
              },
              at: { atUserIds: [senderStaffId], isAtAll: false }
            };
            await replyMessage(data.sessionWebhook, replyBody);
          }

        } catch (error) {
          const err = error as Error;
          console.error('\n❌ 处理文件消息失败:', err.message);
          if (data.sessionWebhook) {
            const errorReply: MarkdownReplyBody = {
              msgtype: 'markdown',
              markdown: {
                title: '文件处理失败',
                text: `## ❌ 文件处理失败\n\n**错误信息：**\n\n\`\`\`\n${err.message}\n\`\`\``
              }
            };
            await replyMessage(data.sessionWebhook, errorReply);
          }
        }
      } else {
        console.log('⚠️  文件消息缺少 downloadCode 或 robotCode');
      }
    }

    console.log('\n##################################################');
    console.log('################## 消息处理完成 ##################');
    console.log('##################################################\n');

    // 返回成功响应
    return { status: 'SUCCESS' };

  } catch (error) {
    const err = error as Error;
    console.error('❌ 处理消息出错:', err);
    console.error('   错误堆栈:', err.stack);
    return { status: 'FAILURE' };
  }
}

/**
 * 通过 sessionWebhook 回复消息
 * @param webhook - sessionWebhook 地址
 * @param body - 消息体
 */
async function replyMessage(webhook: string, body: TextReplyBody | MarkdownReplyBody): Promise<WebhookResponse> {
  console.log('\n========== 通过 Webhook 回复消息 ==========');
  console.log('📤 Webhook URL:', webhook);
  console.log('📤 请求体:', JSON.stringify(body, null, 2));

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const result = await response.json() as WebhookResponse;
    console.log('📥 响应状态:', response.status);
    console.log('📥 响应数据:', JSON.stringify(result, null, 2));

    if (result.errcode !== 0) {
      console.error('❌ 回复消息失败');
    } else {
      console.log('✅ 回复消息成功');
    }
    console.log('========================================\n');
    return result;
  } catch (error) {
    const err = error as Error;
    console.error('❌ 发送回复请求失败:', err);
    console.log('========================================\n');
    throw error;
  }
}

// 注册机器人消息监听器
client.registerCallbackListener(TOPIC_ROBOT, (message: DWClientDownStream) => {
  console.log('\n🔔 收到机器人回调');
  handleRobotMessage(message)
    .then((result) => {
      // 手动返回响应，避免服务端超时重试
      client.socketCallBackResponse(message.headers.messageId, result);
    })
    .catch((err: Error) => {
      console.error('❌ 处理消息异常:', err.message);
      client.socketCallBackResponse(message.headers.messageId, { status: 'FAILURE' });
    });
});

// 注册连接事件监听
client.on('open', () => {
  console.log('✅ Stream 连接已建立');
  console.log('🎉 机器人已准备就绪，等待消息...\n');
});

client.on('close', () => {
  console.log('⚠️  Stream 连接已关闭');
});

client.on('error', (error: Error) => {
  console.error('❌ Stream 连接错误:', error);
});

// 启动连接
console.log('🔄 正在连接钉钉服务器...');
client.connect();

// 优雅退出处理
process.on('SIGINT', () => {
  console.log('\n👋 正在关闭机器人...');
  client.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 正在关闭机器人...');
  client.disconnect();
  process.exit(0);
});
