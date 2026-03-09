import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
  formatPairingApproveHint,
  loadWebMedia,
  missingTargetError,
  normalizeAccountId,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type ChannelAccountSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import path from "path";
import { getDingTalkRuntime } from "./runtime.js";
import {
  listDingTalkAccountIds,
  resolveDefaultDingTalkAccountId,
  resolveDingTalkAccount,
} from "./accounts.js";
import { DingTalkConfigSchema, type DingTalkConfig, type ResolvedDingTalkAccount, type DingTalkGroupConfig } from "./types.js";
import { sendTextMessage, sendImageMessage, sendFileMessage, sendAudioMessage, sendVideoMessage, uploadMedia, probeDingTalkBot, inferMediaType, isGroupTarget } from "./client.js";
import { logger } from "./logger.js";
import { monitorDingTalkProvider } from "./monitor.js";
import { dingtalkOnboardingAdapter } from "./onboarding.js";
import { PLUGIN_ID } from "./constants.js";
import { hasFFmpeg, probeMediaBuffer } from "./ffmpeg.js";

// ======================= Target Normalization =======================

/**
 * 标准化钉钉发送目标
 * 支持格式：
 * - 原始用户 ID
 * - ddingtalk:user:<userId>  → <userId>
 * - ddingtalk:chat:<groupId> → chat:<groupId>（保留 chat: 前缀用于群聊路由）
 * - ddingtalk:<id>
 * - chat:<groupId>（直接群聊格式）
 * - user:<userId>
 */
function normalizeDingTalkTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) {
    return undefined;
  }

  // 处理 ddingtalk:chat:<groupId> → chat:<groupId>
  const chatPrefixPattern = new RegExp(`^${PLUGIN_ID}:chat:`, "i");
  if (chatPrefixPattern.test(trimmed)) {
    const groupId = trimmed.replace(chatPrefixPattern, "");
    return groupId ? `chat:${groupId}` : undefined;
  }

  // 处理 chat:<groupId>（直接保留）
  if (trimmed.startsWith("chat:")) {
    return trimmed.slice(5) ? trimmed : undefined;
  }

  // 去除 ddingtalk:user: 或 ddingtalk: 前缀
  const prefixPattern = new RegExp(`^${PLUGIN_ID}:(?:user:)?`, "i");
  const withoutPrefix = trimmed.replace(prefixPattern, "");

  // 去除 user: 前缀
  const userId = withoutPrefix.replace(/^user:/, "");

  if (!userId) {
    return undefined;
  }

  // 验证格式：钉钉 ID 一般是字母数字组合
  if (/^[a-zA-Z0-9_$+-]+$/i.test(userId)) {
    return userId;
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
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true, // 钉钉不支持流式消息
  },
  commands: {
    enforceOwnerForCommands: true,
  },
  groups: {
    resolveToolPolicy: ({ cfg, accountId, groupId }) => {
      if (!groupId) return undefined;
      const account = resolveDingTalkAccount({ cfg, accountId });
      const groups = account.groups;
      if (!groups) return undefined;
      const key = Object.keys(groups).find(
        (k) => k === groupId || k.toLowerCase() === groupId.toLowerCase()
      );
      return key ? groups[key]?.tools : undefined;
    },
  },
  reload: { configPrefixes: [`channels.${PLUGIN_ID}`] },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  config: {
    listAccountIds: (cfg) => listDingTalkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDingTalkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDingTalkAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: PLUGIN_ID,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: PLUGIN_ID,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        clearBaseFields: ["clientId", "clientSecret", "name"],
      }),
    isConfigured: (account) => Boolean(account.clientId?.trim() && account.clientSecret?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.clientId?.trim() && account.clientSecret?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveDingTalkAccount({ cfg, accountId }).allowFrom.map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(new RegExp(`^${PLUGIN_ID}:(?:user:)?`, "i"), "")),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      const basePath = account.accountId === DEFAULT_ACCOUNT_ID
        ? `channels.${PLUGIN_ID}`
        : `channels.${PLUGIN_ID}.accounts.${account.accountId}`;
      return {
        policy: "allowlist",
        allowFrom: account.allowFrom,
        policyPath: `${basePath}.allowFrom`,
        allowFromPath: `${basePath}.`,
        approveHint: formatPairingApproveHint(PLUGIN_ID),
        normalizeEntry: (raw) => raw.replace(new RegExp(`^${PLUGIN_ID}:(?:user:)?`, "i"), ""),
      };
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      return normalizeDingTalkTarget(trimmed);
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        // 钉钉用户 ID 或群聊 ID
        const prefixPattern = new RegExp(`^${PLUGIN_ID}:`, "i");
        return /^[a-zA-Z0-9_-]+$/i.test(trimmed)
          || prefixPattern.test(trimmed)
          || trimmed.startsWith("chat:")
          || trimmed.startsWith("user:");
      },
      hint: "<userId> or chat:<openConversationId>",
    },
  },

  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: PLUGIN_ID,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        name,
      }),
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
      const aid = normalizeAccountId(accountId);

      // 应用账号名称
      let next = applyAccountNameToChannelSection({
        cfg,
        channelKey: PLUGIN_ID,
        accountId: aid,
        name: typedInput.name,
      });

      const dingtalkConfig = (next.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;

      // default 账号 → 写顶层（兼容旧版 + 前端面板）
      if (aid === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            [PLUGIN_ID]: {
              ...dingtalkConfig,
              enabled: true,
              ...(typedInput.clientId ? { clientId: typedInput.clientId } : {}),
              ...(typedInput.clientSecret ? { clientSecret: typedInput.clientSecret } : {}),
            },
          },
        };
      }

      // 非 default 账号 → 写 accounts[accountId]
      return {
        ...next,
        channels: {
          ...next.channels,
          [PLUGIN_ID]: {
            ...dingtalkConfig,
            enabled: true,
            accounts: {
              ...dingtalkConfig.accounts,
              [aid]: {
                ...dingtalkConfig.accounts?.[aid],
                enabled: true,
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
    /**
     * 解析发送目标
     * 支持以下格式：
     * - 用户 ID：直接是用户的 staffId
     * - 带前缀格式：ddingtalk:user:<userId>
     * - 群聊格式：chat:<openConversationId> 或 ddingtalk:chat:<openConversationId>
     */
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";

      // 如果目标是群聊格式，直接使用（群聊回复时 To 已经是 chat:xxx 格式）
      if (trimmed.startsWith("chat:") || trimmed.startsWith(`${PLUGIN_ID}:chat:`)) {
        const normalized = normalizeDingTalkTarget(trimmed);
        if (normalized) {
          return { ok: true, to: normalized };
        }
      }

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
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: missingTargetError(
              "DingTalk",
              `<userId>, chat:<groupId> 或 channels.${PLUGIN_ID}.allowFrom[0]`,
            ),
          };
        }

        if (mode === "explicit") {
          return { ok: true, to: normalizedTo };
        }

        if (mode === "implicit" || mode === "heartbeat") {
          if (hasWildcard || allowList.length === 0) {
            return { ok: true, to: normalizedTo };
          }
          if (allowList.includes(normalizedTo)) {
            return { ok: true, to: normalizedTo };
          }
          return { ok: true, to: allowList[0] };
        }

        return { ok: true, to: normalizedTo };
      }

      // 没有指定目标
      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }

      return {
        ok: false,
        error: missingTargetError(
          "DingTalk",
          `<userId>, chat:<groupId> 或 channels.${PLUGIN_ID}.allowFrom[0]`,
        ),
      };
    },
    sendText: async ({ to, text, cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      const result = await sendTextMessage(to, text, { account });
      return { channel: PLUGIN_ID, ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, cfg, accountId }) => {
      // 没有媒体 URL，提前返回
      if (!mediaUrl) {
        logger.warn("[sendMedia] 没有 mediaUrl，跳过");
        return { channel: PLUGIN_ID, messageId: "", chatId: to };
      }

      const account = resolveDingTalkAccount({ cfg, accountId });

      try {
        logger.log(`准备发送媒体: ${mediaUrl}`);

        // 使用 OpenClaw 的 loadWebMedia 加载媒体（支持 URL、本地路径、file://、~ 等）
        const media = await loadWebMedia(mediaUrl);
        const mimeType = media.contentType ?? "application/octet-stream";
        const mediaType = inferMediaType(mimeType);

        logger.log(`加载媒体成功 | type: ${mediaType} | mimeType: ${mimeType} | size: ${(media.buffer.length / 1024).toFixed(2)} KB`);

        const fileName = media.fileName || path.basename(mediaUrl) || `file_${Date.now()}`;
        const ext = path.extname(fileName).slice(1) || "file";

        // 上传到钉钉
        const uploadResult = await uploadMedia(media.buffer, fileName, account, {
          mimeType,
          type: mediaType,
        });

        let sendResult: { messageId: string; chatId: string };

        if (mediaType === "image") {
          // 图片使用 photoURL
          sendResult = await sendImageMessage(to, uploadResult.url, { account });
          logger.log("发送图片消息成功");
        } else if (mediaType === "voice" && hasFFmpeg()) {
          // 语音：使用 ffprobe 获取时长，发送原生语音消息
          try {
            const probe = await probeMediaBuffer(media.buffer, fileName, "voice");
            sendResult = await sendAudioMessage(to, uploadResult.mediaId, {
              account,
              duration: String(probe.duration),
            });
            logger.log(`发送语音消息成功 | duration: ${(probe.duration / 1000).toFixed(1)}s`);
          } catch (probeErr) {
            logger.warn(`[sendMedia] 语音探测失败，降级为文件发送: ${probeErr}`);
            sendResult = await sendFileMessage(to, uploadResult.mediaId, fileName, ext, { account });
            logger.log("发送语音消息成功（降级为文件形式）");
          }
        } else if (mediaType === "video" && hasFFmpeg()) {
          // 视频：使用 ffprobe 获取时长和分辨率，提取封面，发送原生视频消息
          try {
            const probe = await probeMediaBuffer(media.buffer, fileName, "video");
            const videoOpts: {
              account: typeof account;
              duration?: string;
              picMediaId?: string;
              width?: string;
              height?: string;
            } = { account };

            if (probe.duration) {
              videoOpts.duration = String(Math.floor(probe.duration / 1000));
            }
            if (probe.width) {
              videoOpts.width = String(probe.width);
            }
            if (probe.height) {
              videoOpts.height = String(probe.height);
            }

            // 上传封面图
            if (probe.coverBuffer) {
              try {
                const coverUpload = await uploadMedia(probe.coverBuffer, "cover.jpg", account, {
                  mimeType: "image/jpeg",
                  type: "image",
                });
                videoOpts.picMediaId = coverUpload.mediaId;
                logger.log(`视频封面上传成功 | picMediaId: ${coverUpload.mediaId}`);
              } catch (coverErr) {
                logger.warn(`[sendMedia] 视频封面上传失败，将不带封面发送: ${coverErr}`);
              }
            }

            sendResult = await sendVideoMessage(to, uploadResult.mediaId, videoOpts);
            logger.log(`发送视频消息成功 | duration: ${(probe.duration / 1000).toFixed(1)}s | ${probe.width}x${probe.height}`);
          } catch (probeErr) {
            logger.warn(`[sendMedia] 视频探测失败，降级为文件发送: ${probeErr}`);
            sendResult = await sendFileMessage(to, uploadResult.mediaId, fileName, ext, { account });
            logger.log("发送视频消息成功（降级为文件形式）");
          }
        } else {
          // 文件 或 无 ffmpeg 的语音/视频：降级为文件发送
          sendResult = await sendFileMessage(to, uploadResult.mediaId, fileName, ext, { account });

          if ((mediaType === "voice" || mediaType === "video") && !hasFFmpeg()) {
            logger.log(`发送${mediaType}消息成功（文件形式，系统未安装 ffmpeg）`);
            // 附带降级提示文本
            const hint = `⚠️ 系统未安装 ffmpeg，${mediaType === "voice" ? "语音" : "视频"}已降级为文件发送。如需原生${mediaType === "voice" ? "语音" : "视频"}体验，请安装 ffmpeg。`;
            await sendTextMessage(to, hint, { account });
          } else {
            logger.log("发送文件消息成功");
          }
        }

        // 如果有文本，再发送文本消息
        if (text?.trim()) {
          await sendTextMessage(to, text, { account });
        }

        return { channel: PLUGIN_ID, ...sendResult };
      } catch (err) {
        logger.error("发送媒体失败:", err);
        // 降级：发送文本消息附带链接
        const fallbackText = text ? `${text}\n\n📎 附件: ${mediaUrl}` : `📎 附件: ${mediaUrl}`;
        const result = await sendTextMessage(to, fallbackText, { account });
        return { channel: PLUGIN_ID, ...result };
      }
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
    logoutAccount: async ({ cfg, accountId: rawAccountId }) => {
      const accountId = normalizeAccountId(rawAccountId);
      const nextCfg = { ...cfg } as OpenClawConfig;
      const dingtalkConfig = (cfg.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
      let cleared = false;
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        // default 账号：清顶层凭据
        const nextDingTalk = { ...dingtalkConfig };
        if (nextDingTalk.clientId || nextDingTalk.clientSecret) {
          delete nextDingTalk.clientId;
          delete nextDingTalk.clientSecret;
          cleared = true;
          changed = true;
        }
        if (changed) {
          nextCfg.channels = { ...nextCfg.channels, [PLUGIN_ID]: nextDingTalk };
        }
      } else {
        // 非 default 账号：清 accounts[accountId] 凭据
        const accounts = { ...(dingtalkConfig.accounts ?? {}) };
        const target = accounts[accountId];
        if (target && (target.clientId || target.clientSecret)) {
          const { clientId: _cid, clientSecret: _cs, ...rest } = target;
          accounts[accountId] = rest;
          cleared = true;
          changed = true;
        }
        if (changed) {
          nextCfg.channels = {
            ...nextCfg.channels,
            [PLUGIN_ID]: { ...dingtalkConfig, accounts },
          };
        }
      }

      if (changed) {
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
