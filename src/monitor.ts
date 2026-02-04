import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { DingTalkMessageData, ResolvedDingTalkAccount } from "./types.js";
import { replyViaWebhook } from "./client.js";
import { resolveDingTalkAccount } from "./accounts.js";
import { getDingTalkRuntime } from "./runtime.js";

export interface MonitorOptions {
  clientId: string;
  clientSecret: string;
  accountId: string;
  config: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}

export interface MonitorResult {
  account: ResolvedDingTalkAccount;
  stop: () => void;
}

// Track runtime state in memory
const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getDingTalkRuntimeState(accountId: string) {
  return runtimeState.get(`dingtalk:${accountId}`);
}

/**
 * 启动钉钉 Stream 监听器
 */
export function monitorDingTalkProvider(options: MonitorOptions): MonitorResult {
  const { clientId, clientSecret, accountId, config, abortSignal } = options;
  const pluginRuntime = getDingTalkRuntime();

  const account = resolveDingTalkAccount({ cfg: config, accountId });

  // Record starting state
  recordChannelRuntimeState({
    channel: "dingtalk",
    accountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  // 创建钉钉 Stream 客户端
  const client = new DWClient({
    clientId,
    clientSecret,
    debug: false,
  });

  // 异步处理消息（不阻塞钉钉响应）
  const processMessageAsync = async (data: DingTalkMessageData) => {
    try {
      // 构建消息上下文
      const isGroup = data.conversationType === "2";
      const senderId = data.senderStaffId;
      const senderName = data.senderNick;

      // 确定 chatId（群聊用 conversationId，单聊用 senderId）
      const chatId = isGroup ? data.conversationId : senderId;

      const textContent = data.text?.content?.trim() ?? "";

      // 构建 From/To 地址
      const fromAddress = isGroup
        ? `dingtalk:group:${data.conversationId}`
        : `dingtalk:${senderId}`;
      const toAddress = fromAddress;

      // 解析路由
      const route = pluginRuntime.channel.routing.resolveAgentRoute({
        cfg: config,
        channel: "dingtalk",
        accountId,
        peer: {
          kind: isGroup ? "group" : "dm",
          id: chatId,
        },
      });

      // 格式化入站消息体
      const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(config);
      const body = pluginRuntime.channel.reply.formatInboundEnvelope({
        channel: "DingTalk",
        from: senderName || senderId,
        timestamp: parseInt(data.createAt),
        body: textContent,
        chatType: isGroup ? "group" : "direct",
        sender: {
          id: senderId,
          name: senderName,
        },
        envelope: envelopeOptions,
      });

      // 构建消息上下文
      const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: textContent,
        CommandBody: textContent,
        From: fromAddress,
        To: toAddress,
        SessionKey: route.sessionKey,
        AccountId: accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: isGroup ? `group:${data.conversationId}` : senderName || senderId,
        GroupSubject: isGroup ? data.conversationId : undefined,
        SenderId: senderId,
        SenderName: senderName,
        Provider: "dingtalk",
        Surface: "dingtalk",
        MessageSid: data.msgId,
        Timestamp: parseInt(data.createAt),
        WasMentioned: data.isInAtList,
        OriginatingChannel: "dingtalk" as const,
        OriginatingTo: toAddress,
      });

      // 调用 OpenClaw 的消息分发
      const { queuedFinal } = await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
          deliver: async (payload) => {
            const replyText = payload.text ?? "";
            if (!replyText) {
              return;
            }

            // 使用 sessionWebhook 回复消息
            if (data.sessionWebhook) {
              const result = await replyViaWebhook(data.sessionWebhook, replyText, {
                atUserIds: isGroup ? [senderId] : undefined,
              });
              if (result.errcode !== 0) {
                throw new Error(`回复失败: ${result.errmsg}`);
              }
            }

            // Record outbound activity
            recordChannelRuntimeState({
              channel: "dingtalk",
              accountId,
              state: {
                lastOutboundAt: Date.now(),
              },
            });
          },
          onError: (err, info) => {
            console.error(`[DingTalk] ${info.kind} reply failed:`, err);
          },
        },
        replyOptions: {},
      });

      if (!queuedFinal) {
        console.log(`[DingTalk] no response generated for message from ${senderName || senderId}`);
      }
    } catch (error) {
      console.error("[DingTalk] 异步处理消息出错:", error);
      recordChannelRuntimeState({
        channel: "dingtalk",
        accountId,
        state: {
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  // 处理消息的回调函数（立即返回成功，异步处理）
  const handleMessage = async (message: DWClientDownStream) => {
    try {
      const data = JSON.parse(message.data) as DingTalkMessageData;

      // Record inbound activity
      recordChannelRuntimeState({
        channel: "dingtalk",
        accountId,
        state: {
          lastInboundAt: Date.now(),
        },
      });

      const senderId = data.senderStaffId;

      // 只处理文本消息
      if (data.msgtype !== "text") {
        // 异步回复不支持的消息类型
        if (data.sessionWebhook) {
          replyViaWebhook(data.sessionWebhook, "暂不支持该类型消息，请发送文本消息。", {
            atUserIds: [senderId],
          }).catch((err) => {
            console.error("[DingTalk] 回复非文本消息提示失败:", err);
          });
        }
        // 立即返回成功响应给钉钉服务器
        client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });
        return;
      }

      const textContent = data.text?.content?.trim() ?? "";

      if (!textContent) {
        client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });
        return;
      }

      // 立即返回成功响应给钉钉服务器，避免超时
      client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });

      // 异步处理消息（不阻塞）
      processMessageAsync(data).catch((err) => {
        console.error("[DingTalk] 异步处理消息失败:", err);
      });
    } catch (error) {
      console.error("[DingTalk] 解析消息出错:", error);
      recordChannelRuntimeState({
        channel: "dingtalk",
        accountId,
        state: {
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      client.socketCallBackResponse(message.headers.messageId, { status: "FAILURE" });
    }
  };

  // 注册消息监听器
  client.registerCallbackListener(TOPIC_ROBOT, handleMessage);

  // 注册连接事件
  client.on("open", () => {
    console.log(`[DingTalk][${accountId}] Stream 连接已建立`);
  });

  client.on("close", () => {
    console.log(`[DingTalk][${accountId}] Stream 连接已关闭`);
    recordChannelRuntimeState({
      channel: "dingtalk",
      accountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  });

  client.on("error", (error: Error) => {
    console.error(`[DingTalk][${accountId}] Stream 连接错误:`, error);
    recordChannelRuntimeState({
      channel: "dingtalk",
      accountId,
      state: {
        lastError: error.message,
      },
    });
  });

  // 启动连接
  client.connect();

  // 处理中止信号
  const stopHandler = () => {
    console.log(`[DingTalk][${accountId}] 停止 provider`);
    client.disconnect();
    recordChannelRuntimeState({
      channel: "dingtalk",
      accountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", stopHandler);
  }

  return {
    account,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
