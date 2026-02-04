import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { DingTalkMessageData, ResolvedDingTalkAccount } from "./types.js";
import { replyViaWebhook, getFileDownloadUrl, downloadFromUrl } from "./client.js";
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
 * 下载钉钉图片并保存到本地
 * @param downloadCode - 图片下载码
 * @param account - 钉钉账户配置
 * @returns 保存的媒体信息
 */
async function downloadAndSaveImage(
  downloadCode: string,
  account: ResolvedDingTalkAccount
): Promise<{ path: string; contentType: string } | undefined> {
  const pluginRuntime = getDingTalkRuntime();

  try {
    // 1. 获取下载链接
    const downloadUrl = await getFileDownloadUrl(downloadCode, account);
    console.log(`[DingTalk] 获取图片下载链接成功`);

    // 2. 下载图片
    const buffer = await downloadFromUrl(downloadUrl);
    console.log(`[DingTalk] 下载图片成功，大小: ${(buffer.length / 1024).toFixed(2)} KB`);

    // 3. 使用 OpenClaw 的 media 工具保存图片
    // contentType 传 undefined，让 OpenClaw 自动检测
    const saved = await pluginRuntime.channel.media.saveMediaBuffer(
      buffer,
      undefined,
      "inbound"
    );

    console.log(`[DingTalk] 图片已保存到: ${saved.path}`);
    return {
      path: saved.path,
      contentType: saved.contentType ?? "image/png",
    };
  } catch (err) {
    console.error("[DingTalk] 下载或保存图片失败:", err);
    return undefined;
  }
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
  const processMessageAsync = async (
    data: DingTalkMessageData,
    mediaInfo?: { path: string; contentType: string }
  ) => {
    try {
      // 构建消息上下文
      const isGroup = data.conversationType === "2";
      const senderId = data.senderStaffId;
      const senderName = data.senderNick;

      // 确定 chatId（群聊用 conversationId，单聊用 senderId）
      const chatId = isGroup ? data.conversationId : senderId;

      // 文本内容：如果是图片消息，使用占位符
      const textContent = data.text?.content?.trim() ?? "";
      const rawBody = textContent || (mediaInfo ? "<media:image>" : "");

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
        body: rawBody,
        chatType: isGroup ? "group" : "direct",
        sender: {
          id: senderId,
          name: senderName,
        },
        envelope: envelopeOptions,
      });

      // 构建消息上下文，包含图片信息
      const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
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
        // 添加图片媒体信息
        MediaPath: mediaInfo?.path,
        MediaType: mediaInfo?.contentType,
        MediaUrl: mediaInfo?.path,
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

      // 打印收到的消息信息
      const isGroup = data.conversationType === "2";
      console.log(`[DingTalk] ========== 收到新消息 ==========`);
      console.log(`[DingTalk] 消息ID: ${data.msgId}`);
      console.log(`[DingTalk] 消息类型: ${data.msgtype}`);
      console.log(`[DingTalk] 发送者: ${data.senderNick} (${data.senderStaffId})`);
      console.log(`[DingTalk] 聊天类型: ${isGroup ? "群聊" : "单聊"}`);
      if (isGroup) {
        console.log(`[DingTalk] 会话ID: ${data.conversationId}`);
      }
      if (data.msgtype === "text") {
        console.log(`[DingTalk] 文本内容: ${data.text?.content?.trim()}`);
      } else if (data.msgtype === "picture") {
        console.log(`[DingTalk] 图片下载码: ${data.content?.downloadCode}`);
      }
      console.log(`[DingTalk] ================================`);

      // Record inbound activity
      recordChannelRuntimeState({
        channel: "dingtalk",
        accountId,
        state: {
          lastInboundAt: Date.now(),
        },
      });

      const senderId = data.senderStaffId;

      // 立即返回成功响应给钉钉服务器，避免超时
      client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });

      // 处理图片消息
      if (data.msgtype === "picture") {
        console.log(`[DingTalk] 收到图片消息，发送者: ${data.senderNick}`);

        const downloadCode = data.content?.downloadCode;
        if (!downloadCode) {
          console.log("[DingTalk] 图片消息缺少 downloadCode");
          if (data.sessionWebhook) {
            replyViaWebhook(data.sessionWebhook, "图片处理失败：缺少下载码", {
              atUserIds: [senderId],
            }).catch((err) => {
              console.error("[DingTalk] 回复图片错误提示失败:", err);
            });
          }
          return;
        }

        // 异步下载并处理图片
        downloadAndSaveImage(downloadCode, account)
          .then((mediaInfo) => {
            if (mediaInfo) {
              // 处理带图片的消息
              processMessageAsync(data, mediaInfo).catch((err) => {
                console.error("[DingTalk] 处理图片消息失败:", err);
              });
            } else {
              // 图片下载/保存失败
              if (data.sessionWebhook) {
                replyViaWebhook(data.sessionWebhook, "图片处理失败，请稍后重试", {
                  atUserIds: [senderId],
                }).catch((err) => {
                  console.error("[DingTalk] 回复图片错误提示失败:", err);
                });
              }
            }
          })
          .catch((err) => {
            console.error("[DingTalk] 下载图片失败:", err);
          });
        return;
      }

      // 处理文本消息
      if (data.msgtype === "text") {
        const textContent = data.text?.content?.trim() ?? "";

        if (!textContent) {
          return;
        }

        // 异步处理消息（不阻塞）
        processMessageAsync(data).catch((err) => {
          console.error("[DingTalk] 异步处理消息失败:", err);
        });
        return;
      }

      // 不支持的消息类型
      if (data.sessionWebhook) {
        replyViaWebhook(data.sessionWebhook, "暂不支持该类型消息，请发送文本或图片消息。", {
          atUserIds: [senderId],
        }).catch((err) => {
          console.error("[DingTalk] 回复非支持消息提示失败:", err);
        });
      }
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
