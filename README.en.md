# @largezhou/ddingtalk

[中文文档](README.md)

OpenClaw DingTalk channel plugin, using Stream mode to connect enterprise robots.

## Features

- ✅ **Stream Mode**: No public IP or domain required, works out of the box
- ✅ **Multi-Account Support**: Connect multiple DingTalk robots simultaneously with separate credentials and permissions
- ✅ **Multi-Agent Routing**: Route different accounts, group chats, and direct messages to different Agents
- ✅ **Private/Group Chat**: Supports private chat and group chat (only when @robot)
- ✅ **Text Messages**: Send and receive text messages
- ✅ **Markdown Reply**: Robot replies in Markdown format
- ✅ **Image Messages**: Receive images from users, send local/remote images
- ✅ **Audio & Video Messages**: Send and receive voice and video messages
- ✅ **File Messages**: Send and receive files, including rich text messages
- ✅ **Active Message Push**: Supports active message pushing, configurable for reminders or scheduled tasks
- ✅ **OpenClaw Commands**: Supports official OpenClaw commands such as /new, /compact

## Installation

```bash
openclaw plugins install @largezhou/ddingtalk
```

---

## Quick Start

There are two ways to add the DingTalk channel:

### Method 1: Add via Installation Wizard (Recommended)

If you have just installed OpenClaw, you can run the wizard directly and follow the prompts to add DingTalk:

```bash
openclaw onboard
```

The wizard will guide you through:

1. Creating a DingTalk app robot and obtaining credentials
2. Configuring app credentials
3. Starting the gateway

**After completing the configuration**, you can use the following commands to check the gateway status:

- `openclaw gateway status` - View gateway running status
- `openclaw logs --follow` - View real-time logs

### Method 2: Add via Command Line

If you have already completed the initial installation, you can use the following command to add the DingTalk channel:

```bash
openclaw channels add
```

Then, follow the interactive prompts to select DingTalk, and enter the AppKey (Client ID) and AppSecret (Client Secret).

**After completing the configuration**, you can use the following commands to manage the gateway:

- `openclaw gateway status` - View gateway running status
- `openclaw gateway restart` - Restart the gateway to apply new configurations
- `openclaw logs --follow` - View real-time logs

---

## Step 1: Create a DingTalk App

### 1. Open the DingTalk Developer Platform

Visit the [DingTalk Developer Platform](https://open-dev.dingtalk.com/fe/app), log in with your DingTalk account, and select an organization to enter.

### 2. Create an App

1. Click **Create App** in the upper right corner
2. Fill in the app name and description, upload an image (optional)

![Create App](docs/images/dingtalk/dingtalk-create-app.png)

### 3. Obtain App Credentials

On the app's **Credentials & Basic Information** page, copy:

- **Client ID** (format like `dingxxxx`)
- **Client Secret**

❗ **Important**: Please keep the Client Secret safe and do not share it with others.

![Obtain App Credentials](docs/images/dingtalk/dingtalk-credentials.png)

### 4. Add an App Robot

1. On the app's **Add App Capabilities** page, select **Robot**, and click Add

![Add Robot](docs/images/dingtalk/dingtalk-create-robot.png)

2. Enter the relevant robot information, select **Stream Mode** for **Message Receiving Mode**, and then save

![Configure Robot](docs/images/dingtalk/dingtalk-robot-config.png)

![Configure Robot Message Receiving Mode](docs/images/dingtalk/dingtalk-robot-config-stream.png)

### 5. Configure App Permissions

In the app's permission management, make sure the following permissions are enabled:

- Permission for enterprise internal robots to send messages
- Permission to obtain download links for robot received messages via downloadCode (for receiving images)

### 6. Publish the Robot

Create a robot version, fill in the version number, description, and application availability scope, click save, then click confirm to publish.

![Create Robot Version](docs/images/dingtalk/dingtalk-create-version.png)

![Edit Version](docs/images/dingtalk/dingtalk-edit-version.png)

---

## Step 2: Configure OpenClaw

### Configure via Wizard (Recommended)

Run the following command, select DingTalk according to the prompts, and paste the AppKey (Client ID) and AppSecret (Client Secret):

```bash
openclaw channels add
```

### Configure via Configuration File

Edit `~/.openclaw/openclaw.json`:

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

### allowFrom Whitelist

`allowFrom` controls which users can interact with the robot and execute commands:

- **Default**: `["*"]` (allows everyone if not configured)
- **Specified users**: Fill in DingTalk user `staffId`, only whitelisted users can use commands (such as `/compact`, `/new`, etc.), messages from non-whitelisted users will be ignored
- `allowFrom[0]` also serves as the default target for active message push (`openclaw send`)

```json
{
  "allowFrom": ["user_id_1", "user_id_2"]
}
```

---

## Multi-Account Configuration

Supports connecting multiple DingTalk robots simultaneously, each corresponding to an independent account. Use cases:

- Different departments use different robots
- A single OpenClaw instance serves multiple DingTalk organizations
- Different robots with different permission policies

### Add a New Account

Add a new account via the wizard, which will interactively prompt for the account ID and credentials:

```bash
openclaw channels add
```

### Configuration File Example

Edit `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "ddingtalk": {
      "enabled": true,
      "accounts": {
        "bot-hr": {
          "name": "HR Assistant",
          "clientId": "dingxxxxxxxx",
          "clientSecret": "secret_1"
        },
        "bot-tech": {
          "name": "Tech Support",
          "clientId": "dingyyyyyyyy",
          "clientSecret": "secret_2"
        }
      },
      "defaultAccount": "bot-hr"
    }
  }
}
```

### Group-Specific Configuration

You can set independent permissions and behavior for specific group chats:

```json
{
  "accounts": {
    "bot-hr": {
      "enabled": true,
      "clientId": "dingxxxxxxxx",
      "clientSecret": "secret_1"
    }
  }
}
```

### Single Account Compatibility

If you only have one robot, there is no need to use `accounts`. You can configure directly at the top level (compatible with the legacy format):

```json
{
  "channels": {
    "ddingtalk": {
      "enabled": true,
      "clientId": "your_app_key",
      "clientSecret": "your_app_secret"
    }
  }
}
```

---

## Multi-Agent Routing

Through OpenClaw's routing bindings mechanism, you can assign different accounts, group chats, and direct messages to different Agents.

> For more about multi-agent concepts and usage, see the [OpenClaw Documentation - Multi-Agent](https://docs.openclaw.ai/zh-CN/concepts/multi-agent).

### Bind Agents by Account

Use the command line to bind different DingTalk accounts to different Agents:

```bash
# Bind bot-hr account to hr-agent
openclaw agents bind --agent hr-agent --bind ddingtalk:bot-hr

# Bind bot-tech account to tech-agent
openclaw agents bind --agent tech-agent --bind ddingtalk:bot-tech

# Bind the entire DingTalk channel (all accounts) to the default agent
openclaw agents bind --agent default-agent --bind ddingtalk
```

View current bindings:

```bash
openclaw agents bindings
```

Remove bindings:

```bash
openclaw agents unbind --agent hr-agent --bind ddingtalk:bot-hr
```

### Bind Agents by Group/Direct Chat

The CLI currently only supports `channel[:accountId]` level bindings. To bind specific group chats or direct messages to different Agents, manually edit the `bindings` configuration in `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "list": [
      { "id": "hr-agent", "name": "HR Assistant" },
      { "id": "tech-agent", "name": "Tech Support" },
      { "id": "general-agent", "name": "General Assistant" }
    ]
  },
  "bindings": [
    {
      "agentId": "tech-agent",
      "comment": "Tech group routes to Tech Support Agent",
      "match": {
        "channel": "ddingtalk",
        "peer": {
          "kind": "group",
          "id": "cidTechGroup001"
        }
      }
    },
    {
      "agentId": "hr-agent",
      "comment": "Zhang San's DM routes to HR Assistant",
      "match": {
        "channel": "ddingtalk",
        "peer": {
          "kind": "direct",
          "id": "user_zhangsan_staffId"
        }
      }
    },
    {
      "agentId": "general-agent",
      "comment": "Other messages from bot-hr go to General Assistant",
      "match": {
        "channel": "ddingtalk",
        "accountId": "bot-hr"
      }
    }
  ]
}
```

---

## Step 3: Start and Test

### 1. Start the Gateway

```bash
openclaw gateway --verbose
```

### 2. Send a Test Message

Find the robot you created in DingTalk, and you can start a normal conversation.

![DingTalk Conversation](docs/images/dingtalk/dingtalk-chat.jpg)

---

## Development

```bash
# Install dependencies
pnpm install

# Pack
pnpm pack
```

## References

- [OpenClaw Multi-Agent Documentation](https://docs.openclaw.ai/concepts/multi-agent)
- [DingTalk Open Platform - Stream Mode](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/overview)
- [DingTalk Open Platform - Robot Receive Messages](https://open.dingtalk.com/document/orgapp/robot-receive-message)
- [DingTalk Open Platform - Robot Send Messages](https://open.dingtalk.com/document/orgapp/robot-send-message)

## License

MIT
