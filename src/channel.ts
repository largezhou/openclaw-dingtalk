import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  loadWebMedia,
  missingTargetError,
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
import { sendTextMessage, sendImageMessage, uploadMedia, probeDingTalkBot } from "./client.js";
import { logger } from "./logger.js";
import { monitorDingTalkProvider } from "./monitor.js";
import { dingtalkOnboardingAdapter } from "./onboarding.js";
import { PLUGIN_ID } from "./constants.js";

// ======================= Target Normalization =======================

/**
 * 标准化钉钉发送目标
 * 支持格式：
 * - 原始用户 ID
 * - ddingtalk:user:<userId>
 * - ddingtalk:<id>
 */
function normalizeDingTalkTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) {
    return undefined;
  }

  // 去除 ddingtalk: 前缀（使用动态正则）
  const prefixPattern = new RegExp(`^${PLUGIN_ID}:(?:user:)?`, "i");
  const withoutPrefix = trimmed.replace(prefixPattern, "");

  if (!withoutPrefix) {
    return undefined;
  }

  // 验证格式：钉钉 ID 一般是字母数字组合
  if (/^[a-zA-Z0-9_$+-]+$/i.test(withoutPrefix)) {
    return withoutPrefix;
  }

  return undefined;
}

// DingTalk channel metadata
const meta = {
  id: PLUGIN_ID,
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉 Stream)",
  detailLabel: "钉钉机器人",
  docsPath: `/channels/${PLUGIN_ID}`,
  docsLabel: PLUGIN_ID,
  blurb: "DingTalk enterprise robot with Stream mode for Chinese market.",
  systemImage: "message.fill",
  aliases: ["dingding", "钉钉"],
};

export const dingtalkPlugin: ChannelPlugin<ResolvedDingTalkAccount> = {
  id: PLUGIN_ID,
  meta,
  onboarding: dingtalkOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true, // 钉钉不支持流式消息
  },
  reload: { configPrefixes: [`channels.${PLUGIN_ID}`] },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  config: {
    listAccountIds: (cfg) => listDingTalkAccountIds(cfg),
    resolveAccount: (cfg, _accountId) => resolveDingTalkAccount({ cfg }),
    defaultAccountId: (_cfg) => resolveDefaultDingTalkAccountId(_cfg),
    setAccountEnabled: ({ cfg, enabled }) => {
      const dingtalkConfig = (cfg.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [PLUGIN_ID]: {
            ...dingtalkConfig,
            enabled,
          },
        },
      };
    },
    deleteAccount: ({ cfg }) => {
      const dingtalkConfig = (cfg.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
      const { clientId, clientSecret, ...rest } = dingtalkConfig;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [PLUGIN_ID]: rest,
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
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      const prefixPattern = new RegExp(`^${PLUGIN_ID}:(?:user:)?`, "i");
      return trimmed.replace(prefixPattern, "");
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        // 钉钉用户 ID 的格式
        const prefixPattern = new RegExp(`^${PLUGIN_ID}:`, "i");
        return /^[a-zA-Z0-9_-]+$/i.test(trimmed) || prefixPattern.test(trimmed);
      },
      hint: "<userId>",
    },
  },

  setup: {
    resolveAccountId: () => normalizeAccountId(),
    applyAccountName: ({ cfg, name }) => {
      const dingtalkConfig = (cfg.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [PLUGIN_ID]: {
            ...dingtalkConfig,
            name,
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
    applyAccountConfig: ({ cfg, input }) => {
      const typedInput = input as {
        name?: string;
        clientId?: string;
        clientSecret?: string;
      };
      const dingtalkConfig = (cfg.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [PLUGIN_ID]: {
            ...dingtalkConfig,
            enabled: true,
            ...(typedInput.name ? { name: typedInput.name } : {}),
            ...(typedInput.clientId ? { clientId: typedInput.clientId } : {}),
            ...(typedInput.clientSecret ? { clientSecret: typedInput.clientSecret } : {}),
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getDingTalkRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: 4000, // 钉钉文本消息长度限制
    /**
     * 解析发送目标
     * 支持以下格式：
     * - 用户 ID：直接是用户的 staffId
     * - 带前缀格式：ddingtalk:user:<userId>
     */
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const hasWildcard = allowListRaw.includes("*");
      const allowList = allowListRaw
        .filter((entry) => entry !== "*")
        .map((entry) => normalizeDingTalkTarget(entry))
        .filter((entry): entry is string => Boolean(entry));

      // 有指定目标
      if (trimmed) {
        const normalizedTo = normalizeDingTalkTarget(trimmed);

        if (!normalizedTo) {
          // 目标格式无效，尝试使用 allowList 的第一个
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: missingTargetError(
              "DingTalk",
              `<userId> 或 channels.${PLUGIN_ID}.allowFrom[0]`,
            ),
          };
        }

        // 显式模式或通配符模式，直接返回
        if (mode === "explicit") {
          return { ok: true, to: normalizedTo };
        }

        // 隐式/心跳模式：检查 allowList
        if (mode === "implicit" || mode === "heartbeat") {
          if (hasWildcard || allowList.length === 0) {
            return { ok: true, to: normalizedTo };
          }
          if (allowList.includes(normalizedTo)) {
            return { ok: true, to: normalizedTo };
          }
          // 不在 allowList 中，使用第一个
          return { ok: true, to: allowList[0] };
        }

        return { ok: true, to: normalizedTo };
      }

      // 没有指定目标，尝试使用 allowList 的第一个
      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }

      return {
        ok: false,
        error: missingTargetError(
          "DingTalk",
          `<userId> 或 channels.${PLUGIN_ID}.allowFrom[0]`,
        ),
      };
    },
    sendText: async ({ to, text, cfg }) => {
      const account = resolveDingTalkAccount({ cfg });
      const result = await sendTextMessage(to, text, { account });
      return { channel: PLUGIN_ID, ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, cfg }) => {
      const account = resolveDingTalkAccount({ cfg });

      // 如果有媒体 URL，尝试发送图片
      if (mediaUrl) {
        try {
          logger.log(`准备发送图片: ${mediaUrl}`);

          // 使用 OpenClaw 的 loadWebMedia 加载媒体（支持 URL、本地路径、file://、~ 等）
          const media = await loadWebMedia(mediaUrl);
          logger.log(`加载图片成功，大小: ${(media.buffer.length / 1024).toFixed(2)} KB`);

          // 上传到钉钉
          const fileName = media.fileName || path.basename(mediaUrl) || `image_${Date.now()}.png`;
          const uploadResult = await uploadMedia(media.buffer, fileName, account);
          logger.log(`上传图片成功，photoURL: ${uploadResult.url}`);

          // 发送图片消息
          const imageResult = await sendImageMessage(to, uploadResult.url, { account });
          logger.log(`发送图片消息成功`);

          // 如果有文本，再发送文本消息
          if (text?.trim()) {
            await sendTextMessage(to, text, { account });
          }

          return { channel: PLUGIN_ID, ...imageResult };
        } catch (err) {
          logger.error("发送图片失败:", err);
          // 降级：发送文本消息附带链接
          const fallbackText = text ? `${text}\n\n📎 图片: ${mediaUrl}` : `📎 图片: ${mediaUrl}`;
          const result = await sendTextMessage(to, fallbackText, { account });
          return { channel: PLUGIN_ID, ...result };
        }
      }

      // 没有媒体，只发送文本
      const result = await sendTextMessage(to, text ?? "", { account });
      return { channel: PLUGIN_ID, ...result };
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
            channel: PLUGIN_ID,
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
    logoutAccount: async ({ cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const dingtalkConfig = (cfg.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
      const nextDingTalk = { ...dingtalkConfig };
      let cleared = false;
      let changed = false;

      if (
        nextDingTalk.clientId ||
        nextDingTalk.clientSecret
      ) {
        delete nextDingTalk.clientId;
        delete nextDingTalk.clientSecret;
        cleared = true;
        changed = true;
      }

      if (changed) {
        if (Object.keys(nextDingTalk).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, [PLUGIN_ID]: nextDingTalk };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete (nextChannels as Record<string, unknown>)[PLUGIN_ID];
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
      });
      const loggedOut = resolved.tokenSource === "none";

      return { cleared, envToken: false, loggedOut };
    },
  },
};
