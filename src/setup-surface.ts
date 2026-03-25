import {
  createAllowFromSection,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  applySetupAccountConfigPatch,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import type {
  ChannelSetupDmPolicy,
  ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  listDingTalkAccountIds,
  resolveDingTalkAccount,
} from "./accounts.js";
import { PLUGIN_ID } from "./constants.js";
import {
  DINGTALK_ALLOWFROM_HELP_LINES,
  DINGTALK_CREDENTIAL_HELP_LINES,
  inspectDingTalkSetupAccount,
  parseDingTalkAllowFromId,
  promptDingTalkAllowFromForAccount,
  resolveDingTalkAllowFromEntries,
} from "./setup-core.js";

const channel = PLUGIN_ID;

/**
 * 钉钉 DM 策略
 */
const dmPolicy: ChannelSetupDmPolicy = {
  label: "DingTalk",
  channel,
  policyKey: `channels.${channel}.dmPolicy`,
  allowFromKey: `channels.${channel}.allowFrom`,
  getCurrent: (cfg) =>
    (cfg.channels?.[channel] as { dmPolicy?: "open" | "pairing" | "allowlist" } | undefined)
      ?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) =>
    applySetupAccountConfigPatch({
      cfg,
      channelKey: channel,
      accountId: DEFAULT_ACCOUNT_ID,
      patch: { dmPolicy: policy },
    }),
  promptAllowFrom: promptDingTalkAllowFromForAccount,
};

/**
 * 钉钉 ChannelSetupWizard — 交互式配置向导
 *
 * 声明式描述了钉钉 Stream 模式机器人的配置流程：
 * 1. 凭据步骤：clientId (AppKey) + clientSecret (AppSecret)
 * 2. AllowFrom：配置允许的用户 ID
 * 3. DM 策略
 */
export const dingtalkSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "DingTalk",
    configuredLabel: "configured",
    unconfiguredLabel: "needs credentials",
    configuredHint: "configured",
    unconfiguredHint: "needs AppKey & AppSecret",
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg }) =>
      listDingTalkAccountIds(cfg).some((accountId) => {
        const account = inspectDingTalkSetupAccount({ cfg, accountId });
        return account.configured;
      }),
  }),

  // 钉钉使用两个凭据：clientId + clientSecret
  // ChannelSetupWizardCredential 每个只处理一个密钥，所以分两步
  credentials: [
    {
      inputKey: "token", // 复用 token 字段映射 clientId
      providerHint: channel,
      credentialLabel: "DingTalk AppKey (Client ID)",
      helpTitle: "DingTalk credentials",
      helpLines: DINGTALK_CREDENTIAL_HELP_LINES,
      envPrompt: "DINGTALK_CLIENT_ID detected. Use env var?",
      keepPrompt: "DingTalk AppKey already configured. Keep it?",
      inputPrompt: "Enter DingTalk AppKey (Client ID)",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const account = inspectDingTalkSetupAccount({ cfg, accountId });
        return {
          accountConfigured: account.configured,
          hasConfiguredValue: account.hasClientId,
          resolvedValue: account.clientId?.trim() || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.DINGTALK_CLIENT_ID?.trim() || undefined
              : undefined,
        };
      },
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId,
          patch: { clientId: resolvedValue },
        }),
    },
    {
      inputKey: "privateKey", // 复用 privateKey 字段映射 clientSecret
      providerHint: channel,
      credentialLabel: "DingTalk AppSecret (Client Secret)",
      envPrompt: "DINGTALK_CLIENT_SECRET detected. Use env var?",
      keepPrompt: "DingTalk AppSecret already configured. Keep it?",
      inputPrompt: "Enter DingTalk AppSecret (Client Secret)",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const account = inspectDingTalkSetupAccount({ cfg, accountId });
        return {
          accountConfigured: account.configured,
          hasConfiguredValue: account.hasClientSecret,
          resolvedValue: account.clientSecret?.trim() || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.DINGTALK_CLIENT_SECRET?.trim() || undefined
              : undefined,
        };
      },
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId,
          patch: { clientSecret: resolvedValue },
        }),
    },
  ],

  // allowFrom 配置
  allowFrom: createAllowFromSection({
    helpTitle: "DingTalk user id",
    helpLines: DINGTALK_ALLOWFROM_HELP_LINES,
    message: "DingTalk allowFrom (user IDs)",
    placeholder: "userId1, userId2",
    invalidWithoutCredentialNote:
      "Please enter valid DingTalk user IDs (alphanumeric format).",
    parseInputs: splitSetupEntries,
    parseId: parseDingTalkAllowFromId,
    resolveEntries: async ({ entries }) =>
      resolveDingTalkAllowFromEntries({ entries }),
    apply: async ({ cfg, accountId, allowFrom }) =>
      applySetupAccountConfigPatch({
        cfg,
        channelKey: channel,
        accountId,
        patch: { allowFrom },
      }),
  }),

  dmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
