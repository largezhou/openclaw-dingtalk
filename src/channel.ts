import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  loadWebMedia,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type ChannelAccountSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import path from "path";
import { getDingTalkRuntime } from "./runtime.js";
import {
  listDingTalkAccountIds,
  normalizeAccountId,
  resolveDefaultDingTalkAccountId,
  resolveDingTalkAccount,
} from "./accounts.js";
import { DingTalkConfigSchema, type DingTalkConfig, type ResolvedDingTalkAccount } from "./types.js";
import { sendTextMessage, sendImageMessage, uploadMedia, probeDingTalkBot, replyViaWebhook } from "./client.js";
import { monitorDingTalkProvider } from "./monitor.js";
import { dingtalkOnboardingAdapter } from "./onboarding.js";

// DingTalk channel metadata
const meta = {
  id: "dingtalk",
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉 Stream)",
  detailLabel: "钉钉机器人",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  blurb: "DingTalk enterprise robot with Stream mode for Chinese market.",
  systemImage: "message.fill",
  aliases: ["dingding", "钉钉"],
};

export const dingtalkPlugin: ChannelPlugin<ResolvedDingTalkAccount> = {
  id: "dingtalk",
  meta,
  onboarding: dingtalkOnboardingAdapter,
  pairing: {
    idLabel: "dingtalkUserId",
    normalizeAllowEntry: (entry) => {
      // 钉钉用户 ID 处理：去除前缀
      return entry.replace(/^dingtalk:(?:user:)?/i, "");
    },
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveDingTalkAccount({ cfg });
      if (!account.clientId || !account.clientSecret) {
        throw new Error("DingTalk credentials not configured");
      }
      await sendTextMessage(id, "OpenClaw: 您的访问权限已通过审批。", {
        account,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true, // 钉钉不支持流式消息
  },
  reload: { configPrefixes: ["channels.dingtalk"] },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  config: {
    listAccountIds: (cfg) => listDingTalkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDingTalkAccount({ cfg, accountId: accountId ?? undefined }),
    defaultAccountId: (cfg) => resolveDefaultDingTalkAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const dingtalkConfig = (cfg.channels?.dingtalk ?? {}) as DingTalkConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            dingtalk: {
              ...dingtalkConfig,
              enabled,
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dingtalkConfig,
            accounts: {
              ...dingtalkConfig.accounts,
              [accountId]: {
                ...dingtalkConfig.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const dingtalkConfig = (cfg.channels?.dingtalk ?? {}) as DingTalkConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { clientId, clientSecret, ...rest } = dingtalkConfig;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            dingtalk: rest,
          },
        };
      }
      const accounts = { ...dingtalkConfig.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dingtalkConfig,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => Boolean(account.clientId?.trim() && account.clientSecret?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.clientId?.trim() && account.clientSecret?.trim()),
      tokenSource: account.tokenSource,
    }),
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId: accountId ?? undefined });
      const groups = account.config.groups;
      if (!groups || !groupId) {
        return false;
      }
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.requireMention ?? false;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      return trimmed.replace(/^dingtalk:(user|group):/i, "").replace(/^dingtalk:/i, "");
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        // 钉钉用户 ID 和群会话 ID 的格式
        return /^[a-zA-Z0-9_-]+$/i.test(trimmed) || /^dingtalk:/i.test(trimmed);
      },
      hint: "<userId|conversationId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => {
      const dingtalkConfig = (cfg.channels?.dingtalk ?? {}) as DingTalkConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            dingtalk: {
              ...dingtalkConfig,
              name,
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dingtalkConfig,
            accounts: {
              ...dingtalkConfig.accounts,
              [accountId]: {
                ...dingtalkConfig.accounts?.[accountId],
                name,
              },
            },
          },
        },
      };
    },
    validateInput: ({ input }) => {
      const typedInput = input as {
        clientId?: string;
        clientSecret?: string;
      };
      if (!typedInput.clientId) {
        return "DingTalk requires clientId.";
      }
      if (!typedInput.clientSecret) {
        return "DingTalk requires clientSecret.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const typedInput = input as {
        name?: string;
        clientId?: string;
        clientSecret?: string;
      };
      const dingtalkConfig = (cfg.channels?.dingtalk ?? {}) as DingTalkConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            dingtalk: {
              ...dingtalkConfig,
              enabled: true,
              ...(typedInput.name ? { name: typedInput.name } : {}),
              ...(typedInput.clientId ? { clientId: typedInput.clientId } : {}),
              ...(typedInput.clientSecret ? { clientSecret: typedInput.clientSecret } : {}),
            },
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dingtalkConfig,
            enabled: true,
            accounts: {
              ...dingtalkConfig.accounts,
              [accountId]: {
                ...dingtalkConfig.accounts?.[accountId],
                enabled: true,
                ...(typedInput.name ? { name: typedInput.name } : {}),
                ...(typedInput.clientId ? { clientId: typedInput.clientId } : {}),
                ...(typedInput.clientSecret ? { clientSecret: typedInput.clientSecret } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getDingTalkRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: 4000, // 钉钉文本消息长度限制
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveDingTalkAccount({ cfg, accountId: accountId ?? undefined });
      const result = await sendTextMessage(to, text, { account });
      return { channel: "dingtalk", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveDingTalkAccount({ cfg, accountId: accountId ?? undefined });

      // 如果有媒体 URL，尝试发送图片
      if (mediaUrl) {
        try {
          console.log(`[DingTalk] 准备发送图片: ${mediaUrl}`);

          // 使用 OpenClaw 的 loadWebMedia 加载媒体（支持 URL、本地路径、file://、~ 等）
          const media = await loadWebMedia(mediaUrl);
          console.log(`[DingTalk] 加载图片成功，大小: ${(media.buffer.length / 1024).toFixed(2)} KB`);

          // 上传到钉钉
          const fileName = media.fileName || path.basename(mediaUrl) || `image_${Date.now()}.png`;
          const uploadResult = await uploadMedia(media.buffer, fileName, account);
          console.log(`[DingTalk] 上传图片成功，photoURL: ${uploadResult.url}`);

          // 发送图片消息
          const imageResult = await sendImageMessage(to, uploadResult.url, { account });
          console.log(`[DingTalk] 发送图片消息成功`);

          // 如果有文本，再发送文本消息
          if (text?.trim()) {
            await sendTextMessage(to, text, { account });
          }

          return { channel: "dingtalk", ...imageResult };
        } catch (err) {
          console.error("[DingTalk] 发送图片失败:", err);
          // 降级：发送文本消息附带链接
          const fallbackText = text ? `${text}\n\n📎 图片: ${mediaUrl}` : `📎 图片: ${mediaUrl}`;
          const result = await sendTextMessage(to, fallbackText, { account });
          return { channel: "dingtalk", ...result };
        }
      }

      // 没有媒体，只发送文本
      const result = await sendTextMessage(to, text ?? "", { account });
      return { channel: "dingtalk", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts: ChannelAccountSnapshot[]) => {
      const issues: ChannelStatusIssue[] = [];
      for (const account of accounts) {
        const accountId = account.accountId ?? DEFAULT_ACCOUNT_ID;
        // Check if configured flag is false
        if (!account.configured) {
          issues.push({
            channel: "dingtalk",
            accountId,
            kind: "config",
            message: "DingTalk credentials (clientId/clientSecret) not configured",
          });
        }
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => probeDingTalkBot(account, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.clientId?.trim() && account.clientSecret?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: "stream",
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const clientId = account.clientId.trim();
      const clientSecret = account.clientSecret.trim();

      let botLabel = "";
      try {
        const probe = await probeDingTalkBot(account, 2500);
        const displayName = probe.ok ? probe.bot?.name?.trim() : null;
        if (displayName) {
          botLabel = ` (${displayName})`;
        }
      } catch (err) {
        if (getDingTalkRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }

      ctx.log?.info(`[${account.accountId}] starting DingTalk provider${botLabel}`);

      return monitorDingTalkProvider({
        clientId,
        clientSecret,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const dingtalkConfig = (cfg.channels?.dingtalk ?? {}) as DingTalkConfig;
      const nextDingTalk = { ...dingtalkConfig };
      let cleared = false;
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (
          nextDingTalk.clientId ||
          nextDingTalk.clientSecret
        ) {
          delete nextDingTalk.clientId;
          delete nextDingTalk.clientSecret;
          cleared = true;
          changed = true;
        }
      }

      const accounts = nextDingTalk.accounts ? { ...nextDingTalk.accounts } : undefined;
      if (accounts && accountId in accounts) {
        const entry = accounts[accountId];
        if (entry && typeof entry === "object") {
          const nextEntry = { ...entry } as Record<string, unknown>;
          if (
            "clientId" in nextEntry ||
            "clientSecret" in nextEntry
          ) {
            cleared = true;
            delete nextEntry.clientId;
            delete nextEntry.clientSecret;
            changed = true;
          }
          if (Object.keys(nextEntry).length === 0) {
            delete accounts[accountId];
            changed = true;
          } else {
            accounts[accountId] = nextEntry as typeof entry;
          }
        }
      }

      if (accounts) {
        if (Object.keys(accounts).length === 0) {
          delete nextDingTalk.accounts;
          changed = true;
        } else {
          nextDingTalk.accounts = accounts;
        }
      }

      if (changed) {
        if (Object.keys(nextDingTalk).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, dingtalk: nextDingTalk };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete (nextChannels as Record<string, unknown>).dingtalk;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        await getDingTalkRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = resolveDingTalkAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";

      return { cleared, envToken: false, loggedOut };
    },
  },
};
