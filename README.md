# @largezhou/ddingtalk

OpenClaw 钉钉（DingTalk）渠道插件，使用 Stream 模式接入企业机器人。

## 功能特点

- ✅ **Stream 模式**：无需公网 IP 和域名，开箱即用
- ✅ **私聊/群聊**：支持私聊，群聊（仅@机器人）
- ✅ **文本消息收发**：接收和发送文本消息
- ✅ **Markdown回复**：机器人回复 Markdown 格式
- ✅ **图片消息收发**：接收用户发送的图片，支持发送本地/远程图片
- ✅ **语音、视频、文件、图文混排**：接收用户发送语音、视频、文件、图文混排消息
- ✅ **回复文件**：支持回复文件，音频、视频等统一按文件发送（按语音、视频发送，需要获取时长、视频封面，以后再支持）
- ✅ **主动推送消息**：支持主动推送消息，可以配置提醒或定时任务
- ✅ **支持OpenClaw命令**：支持 /new、/compact 等 OpenClaw 官方命令

## 安装

```bash
openclaw plugins install @largezhou/ddingtalk
```

## 前置准备

### 1. 创建钉钉企业内部应用

1. 登录 [钉钉开发者后台](https://open-dev.dingtalk.com/fe/app)
2. 创建应用
3. 记录 **AppKey** (ClientID) 和 **AppSecret** (ClientSecret)

### 2. 开通机器人能力

1. 在应用详情页，点击 **应用能力** -> **添加应用能力**
2. 选择 **机器人**
3. 填写机器人基本信息
4. **重要**: 消息接收模式选择 **Stream 模式**
5. 发布应用

### 3. 配置应用权限

在应用的权限管理中，确保开通以下权限：

- 企业内机器人发送消息权限
- 根据 downloadCode 获取机器人接收消息的下载链接（用于接收图片）

## 配置

### 方式一：交互式配置（推荐）

```bash
openclaw channels add
```

选择 DingTalk，按提示输入 AppKey 和 AppSecret 即可。

### 方式二：手动配置

在 OpenClaw 配置文件 `~/.openclaw/openclaw.json` 中添加：

```json
{
   "channels": {
     "ddingtalk": {
        "enabled": true,
        "clientId": "your_app_key",
        "clientSecret": "your_app_secret",
        "allowFrom": ["*"]
     }
   }
}
```

### allowFrom 白名单

`allowFrom` 控制哪些用户可以与机器人交互并执行命令：

- **默认值**：`["*"]`（不配置的情况下，默认允许所有人）
- **指定用户**：填入钉钉用户的 `staffId`，只有白名单内的用户才能使用命令（如 `/compact`、`/new` 等），白名单外的用户消息会被忽略
- `allowFrom[0]` 同时作为主动推送消息（`openclaw send`）的默认目标

```json
{
  "allowFrom": ["用户ID_1", "用户ID_2"]
}
```

## Demo

项目包含独立的 demo 示例，可以脱离 OpenClaw 框架单独测试钉钉机器人

```bash
# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 CLIENT_ID 和 CLIENT_SECRET

# 运行 demo
npm run demo
```

## 开发

```bash
# 安装依赖
npm install

# 打包
npm pack
```

## 参考文档

- [钉钉开放平台 - Stream 模式说明](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/overview)
- [钉钉开放平台 - 机器人接收消息](https://open.dingtalk.com/document/orgapp/robot-receive-message)
- [钉钉开放平台 - 机器人发送消息](https://open.dingtalk.com/document/orgapp/robot-send-message)

## License

MIT
