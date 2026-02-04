# 钉钉机器人 Stream 模式开发技术文档

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 环境配置](#2-环境配置)
- [3. 核心概念](#3-核心概念)
- [4. 收到消息的数据结构](#4-收到消息的数据结构)
- [5. API 功能详解](#5-api-功能详解)
  - [5.1 获取 Access Token](#51-获取-access-token)
  - [5.2 被动回复消息（sessionWebhook）](#52-被动回复消息sessionwebhook)
  - [5.3 主动发送单聊消息（batchSendOTO）](#53-主动发送单聊消息batchsendoto)
  - [5.4 主动发送群聊消息（orgGroupSend）](#54-主动发送群聊消息orggroupsend)
  - [5.5 下载用户发送的图片/文件](#55-下载用户发送的图片文件)
  - [5.6 上传媒体文件](#56-上传媒体文件)
- [6. 消息类型（msgKey）](#6-消息类型msgkey)
- [7. 完整流程示例](#7-完整流程示例)

---

## 1. 项目概述

本项目是一个基于钉钉 Stream 模式的机器人 Demo，实现了以下功能：

- 接收并处理用户消息（文本、图片）
- 被动回复消息（使用 sessionWebhook）
- 主动发送消息（不依赖 sessionWebhook）
- 下载用户发送的图片并保存到本地
- 上传本地图片并发送给用户
- 定时任务（每 30 秒给用户发送消息）

### 依赖包

```json
{
  "dingtalk-stream": "钉钉 Stream 客户端",
  "@alicloud/dingtalk": "钉钉官方 SDK",
  "@alicloud/openapi-client": "阿里云 OpenAPI 客户端",
  "@alicloud/tea-util": "Tea 工具库",
  "dotenv": "环境变量管理"
}
```

---

## 2. 环境配置

### 2.1 创建 `.env` 文件

```bash
CLIENT_ID=你的AppKey
CLIENT_SECRET=你的AppSecret
```

| 变量 | 说明 | 获取方式 |
|------|------|----------|
| `CLIENT_ID` | 钉钉应用的 AppKey | 钉钉开放平台 → 应用开发 → 企业内部应用 → 凭证与基础信息 |
| `CLIENT_SECRET` | 钉钉应用的 AppSecret | 同上 |

### 2.2 启动项目

```bash
npm install
npm start
```

---

## 3. 核心概念

### 3.1 两种发送消息方式对比

| 方式 | 接口 | 特点 | 适用场景 |
|------|------|------|----------|
| **被动回复** | `sessionWebhook` | 临时地址，有效期约 1 小时 | 收到消息后立即回复 |
| **主动发送** | `batchSendOTO` / `orgGroupSend` | 需要 access_token，无时间限制 | 定时任务、主动推送、异步通知 |

### 3.2 关键参数来源

| 参数 | 说明 | 来源 |
|------|------|------|
| `robotCode` | 机器人编码 | 等于 `CLIENT_ID`（AppKey），也可从收到的消息 `data.robotCode` 获取 |
| `userId` / `senderStaffId` | 用户 ID | 从收到的消息 `data.senderStaffId` 获取 |
| `conversationId` | 会话 ID（群聊） | 从收到的消息 `data.conversationId` 获取 |
| `sessionWebhook` | 临时回复地址 | 从收到的消息 `data.sessionWebhook` 获取 |
| `downloadCode` | 文件下载码 | 从收到的图片消息 `data.content.downloadCode` 获取 |

---

## 4. 收到消息的数据结构

当机器人收到用户消息时，会获得如下数据结构：

```json
{
  "conversationId": "cidXXXXXXXX",           // 会话ID（群聊时用于发送群消息）
  "conversationType": "1",                    // 会话类型: "1"=单聊, "2"=群聊
  "msgId": "msgXXXXXXXX",                    // 消息ID
  "msgtype": "text",                          // 消息类型: text, picture, richText 等
  "createAt": "1234567890123",               // 消息创建时间戳
  "senderNick": "张三",                       // 发送者昵称
  "senderStaffId": "user123",                // ⭐ 发送者用户ID（主动发消息需要）
  "senderCorpId": "corpXXX",                 // 发送者企业ID
  "robotCode": "dingXXXXXXXX",               // ⭐ 机器人编码（主动发消息需要）
  "sessionWebhook": "https://oapi...",       // ⭐ 临时回复地址（被动回复需要）
  "sessionWebhookExpiredTime": "1234567890123", // webhook 过期时间
  "isInAtList": true,                        // 是否在@列表中
  "text": {                                  // 文本消息内容
    "content": "你好"
  },
  "content": {                               // 图片消息内容
    "downloadCode": "XXXXX",                 // ⭐ 图片下载码（下载图片需要）
    "pictureDownloadCode": "XXXXX"
  }
}
```

### 关键字段用途

| 字段 | 用途 |
|------|------|
| `senderStaffId` | 主动发送单聊消息时的目标用户 |
| `conversationId` | 主动发送群聊消息时的目标群 |
| `robotCode` | 调用所有主动发送接口时必需 |
| `sessionWebhook` | 被动回复消息时使用 |
| `content.downloadCode` | 下载用户发送的图片时使用 |

---

## 5. API 功能详解

### 5.1 获取 Access Token

所有主动调用钉钉 API 都需要先获取 `access_token`。

#### 函数签名

```javascript
async function getAccessToken(): Promise<string>
```

#### 参数来源

| 参数 | 来源 |
|------|------|
| `appKey` | 环境变量 `CLIENT_ID` |
| `appSecret` | 环境变量 `CLIENT_SECRET` |

#### 返回值

```javascript
{
  accessToken: "xxxxxxxxxx",  // 访问令牌
  expireIn: 7200              // 有效期（秒）
}
```

#### 注意事项

- Token 有效期为 2 小时（7200 秒）
- 代码中已实现自动缓存和刷新机制

---

### 5.2 被动回复消息（sessionWebhook）

收到消息后，通过 `sessionWebhook` 立即回复。

#### 函数签名

```javascript
async function replyMessage(webhook: string, body: object): Promise<object>
```

#### 参数说明

| 参数 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `webhook` | string | `data.sessionWebhook` | 从收到的消息中获取 |
| `body` | object | 自行构造 | 消息体 |

#### 消息体格式（文本消息）

```javascript
{
  msgtype: 'text',
  text: {
    content: '回复内容'
  },
  at: {
    atUserIds: ['user123'],  // @ 指定用户（可选）
    isAtAll: false           // 是否 @ 所有人
  }
}
```

#### 使用示例

```javascript
// data 是收到的消息
if (data.sessionWebhook) {
  await replyMessage(data.sessionWebhook, {
    msgtype: 'text',
    text: { content: '收到你的消息了！' },
    at: { atUserIds: [data.senderStaffId], isAtAll: false }
  });
}
```

#### 特点

- ✅ 简单快速，不需要 access_token
- ❌ webhook 有效期约 1 小时
- ❌ 只能在收到消息后使用

---

### 5.3 主动发送单聊消息（batchSendOTO）

主动给指定用户发送单聊消息，不依赖 sessionWebhook。

#### 函数签名

```javascript
// 发送文本
async function sendTextToUser(userId: string, content: string, robotCode: string): Promise<object>

// 发送图片
async function sendImageToUser(userId: string, photoURL: string, robotCode: string): Promise<object>
```

#### 参数说明

| 参数 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `userId` | string | `data.senderStaffId` | 从收到的消息中获取，或从其他接口查询 |
| `content` | string | 自定义 | 文本消息内容 |
| `photoURL` | string | 上传图片后获取 | 图片的公网可访问 URL |
| `robotCode` | string | `data.robotCode` 或 `CLIENT_ID` | 机器人编码 |

#### 底层实现

使用钉钉 SDK 的 `BatchSendOTORequest`：

```javascript
const request = new robotModule.BatchSendOTORequest({
  robotCode: robotCode,       // 机器人编码
  userIds: [userId],          // 用户ID数组，最多20个
  msgKey: 'sampleText',       // 消息类型
  msgParam: JSON.stringify({  // 消息参数
    content: '消息内容'
  })
});
```

#### 使用示例

```javascript
// 场景1: 收到消息后主动发送（从消息中获取参数）
const userId = data.senderStaffId;    // 从收到的消息获取
const robotCode = data.robotCode;     // 从收到的消息获取
await sendTextToUser(userId, '你好！', robotCode);

// 场景2: 定时任务主动发送（参数需要提前保存）
// 需要在收到消息时保存 userId 和 robotCode
await sendTextToUser(savedUserId, '定时消息', CLIENT_ID);
```

#### 特点

- ✅ 可随时主动发送，不受时间限制
- ✅ 可批量发送给多个用户（最多 20 个）
- ❌ 需要 access_token
- ❌ 需要知道目标用户的 userId

---

### 5.4 主动发送群聊消息（orgGroupSend）

主动给指定群发送消息。

#### 函数签名

```javascript
// 发送图片
async function sendImageToGroup(openConversationId: string, photoURL: string, robotCode: string): Promise<object>
```

#### 参数说明

| 参数 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `openConversationId` | string | `data.conversationId` | 从收到的群消息中获取 |
| `photoURL` | string | 上传图片后获取 | 图片的公网可访问 URL |
| `robotCode` | string | `data.robotCode` 或 `CLIENT_ID` | 机器人编码 |

#### 底层实现

使用钉钉 SDK 的 `OrgGroupSendRequest`：

```javascript
const request = new robotModule.OrgGroupSendRequest({
  robotCode: robotCode,
  openConversationId: openConversationId,
  msgKey: 'sampleText',
  msgParam: JSON.stringify({
    content: '消息内容'
  })
});
```

#### 使用示例

```javascript
// data 是收到的群消息
const conversationId = data.conversationId;  // 从收到的消息获取
const robotCode = data.robotCode;            // 从收到的消息获取
await sendImageToGroup(conversationId, photoURL, robotCode);
```

---

### 5.5 下载用户发送的图片/文件

当用户发送图片给机器人时，需要通过 `downloadCode` 获取下载链接。

#### 流程

```
收到图片消息 → 获取 downloadCode → 调用 API 获取下载链接 → 下载文件
```

#### 函数签名

```javascript
async function getFileDownloadUrl(downloadCode: string, robotCode: string): Promise<string>
async function downloadFromUrl(url: string): Promise<Buffer>
```

#### 参数说明

| 参数 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `downloadCode` | string | `data.content.downloadCode` | 从收到的图片消息中获取 |
| `robotCode` | string | `data.robotCode` | 从收到的消息中获取 |

#### 使用示例

```javascript
// 处理图片消息
if (data.msgtype === 'picture') {
  const downloadCode = data.content.downloadCode;  // 从消息获取
  const robotCode = data.robotCode;                // 从消息获取
  
  // 1. 获取下载链接
  const downloadUrl = await getFileDownloadUrl(downloadCode, robotCode);
  
  // 2. 下载文件
  const imageBuffer = await downloadFromUrl(downloadUrl);
  
  // 3. 保存到本地
  const filePath = saveImageToTmp(imageBuffer, 'image.png');
}
```

---

### 5.6 上传媒体文件

将本地文件上传到钉钉，获取可用于发送消息的 URL。

#### 函数签名

```javascript
async function uploadMedia(filePath: string, type: string): Promise<{mediaId: string, url: string}>
```

#### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `filePath` | string | 本地文件路径 |
| `type` | string | 文件类型：`image`, `voice`, `video`, `file` |

#### 返回值

```javascript
{
  mediaId: '@media_id_xxx',   // 媒体文件 ID
  url: 'https://oapi.dingtalk.com/media/downloadFile?...'  // 公网可访问 URL
}
```

#### 使用示例

```javascript
// 上传本地图片
const uploadResult = await uploadMedia('/path/to/image.png', 'image');
const photoURL = uploadResult.url;

// 使用 photoURL 发送图片
await sendImageToUser(userId, photoURL, robotCode);
```

---

## 6. 消息类型（msgKey）

发送消息时通过 `msgKey` 指定消息类型：

| msgKey | 说明 | msgParam 格式 |
|--------|------|--------------|
| `sampleText` | 文本消息 | `{"content": "文本内容"}` |
| `sampleMarkdown` | Markdown 消息 | `{"title": "标题", "text": "# Markdown内容"}` |
| `sampleImageMsg` | 图片消息 | `{"photoURL": "https://xxx.png"}` |
| `sampleLink` | 链接消息 | `{"title": "标题", "text": "描述", "messageUrl": "https://...", "picUrl": "https://..."}` |
| `sampleActionCard` | 卡片消息 | `{"title": "标题", "text": "内容", "singleTitle": "按钮", "singleURL": "https://..."}` |

---

## 7. 完整流程示例

### 7.1 收到文本消息并主动回复

```javascript
async function handleTextMessage(data) {
  // 从消息中提取关键参数
  const userId = data.senderStaffId;      // 用户ID
  const robotCode = data.robotCode;        // 机器人编码
  const content = data.text.content;       // 消息内容
  
  // 方式1: 被动回复（使用 sessionWebhook）
  if (data.sessionWebhook) {
    await replyMessage(data.sessionWebhook, {
      msgtype: 'text',
      text: { content: '收到: ' + content }
    });
  }
  
  // 方式2: 主动发送（使用 batchSendOTO）
  await sendTextToUser(userId, '这是主动发送的消息', robotCode);
}
```

### 7.2 收到图片并回发

```javascript
async function handlePictureMessage(data) {
  // 1. 提取参数
  const downloadCode = data.content.downloadCode;
  const robotCode = data.robotCode;
  const userId = data.senderStaffId;
  const conversationType = data.conversationType;
  const conversationId = data.conversationId;
  
  // 2. 下载图片
  const downloadUrl = await getFileDownloadUrl(downloadCode, robotCode);
  const imageBuffer = await downloadFromUrl(downloadUrl);
  
  // 3. 保存到本地
  const filePath = saveImageToTmp(imageBuffer, `image_${Date.now()}.png`);
  
  // 4. 上传图片获取 URL
  const uploadResult = await uploadMedia(filePath, 'image');
  const photoURL = uploadResult.url;
  
  // 5. 发送图片
  if (conversationType === '1') {
    // 单聊
    await sendImageToUser(userId, photoURL, robotCode);
  } else {
    // 群聊
    await sendImageToGroup(conversationId, photoURL, robotCode);
  }
}
```

### 7.3 定时任务主动发送

```javascript
// 存储用户信息用于定时任务
const userTimers = new Map();

function startTimer(userId, robotCode) {
  const intervalId = setInterval(async () => {
    await sendTextToUser(userId, '定时消息', robotCode);
  }, 30000); // 30秒
  
  userTimers.set(userId, intervalId);
}

function stopTimer(userId) {
  if (userTimers.has(userId)) {
    clearInterval(userTimers.get(userId));
    userTimers.delete(userId);
  }
}

// 收到消息时启动定时任务
async function handleMessage(data) {
  if (data.text.content === '开始') {
    // 保存 userId 和 robotCode 用于定时任务
    startTimer(data.senderStaffId, data.robotCode);
  }
  if (data.text.content === '停止') {
    stopTimer(data.senderStaffId);
  }
}
```

---

## 附录：参数获取速查表

| 你要做什么 | 需要什么参数 | 参数从哪里来 |
|------------|--------------|--------------|
| 被动回复消息 | `sessionWebhook` | `data.sessionWebhook` |
| 主动发单聊消息 | `userId`, `robotCode` | `data.senderStaffId`, `data.robotCode` |
| 主动发群聊消息 | `conversationId`, `robotCode` | `data.conversationId`, `data.robotCode` |
| 下载用户图片 | `downloadCode`, `robotCode` | `data.content.downloadCode`, `data.robotCode` |
| 发送图片消息 | `photoURL` | 先调用 `uploadMedia()` 获取 |
| 调用任何 API | `access_token` | 调用 `getAccessToken()` 获取 |
