# @largezhou/openclaw-dingtalk

OpenClaw 钉钉（DingTalk）渠道插件，使用 Stream 模式接入企业机器人。

## 功能特点

- 使用 Stream 模式（无需公网 IP 和域名）
- 支持单聊和群聊消息
- 支持多账户配置
- 异步消息处理，避免超时

## 安装

```bash
openclaw plugins install https://github.com/largezhou/openclaw-dingtalk.git
```

## 前置准备

### 1. 创建钉钉企业内部应用

1. 登录 [钉钉开发者后台](https://open-dev.dingtalk.com/)
2. 创建一个**企业内部应用**
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

## 配置

在 OpenClaw 配置文件中添加钉钉渠道配置：

```yaml
channels:
  dingtalk:
    enabled: true
    clientId: "your_app_key"
    clientSecret: "your_app_secret"
```

或者使用 `openclaw channels add` 交互式配置

## Demo

项目包含独立的 demo 示例，可以脱离 OpenClaw 框架单独测试钉钉机器人：

```bash
# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 CLIENT_ID 和 CLIENT_SECRET

# 运行 demo
npm run demo
```

## 参考文档

- [钉钉开放平台 - Stream 模式说明](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/overview)
- [钉钉开放平台 - 机器人接收消息](https://open.dingtalk.com/document/orgapp/robot-receive-message)

## License

MIT
