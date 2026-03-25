import {
  applySetupAccountConfigPatch,
  splitSetupEntries,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  resolveDefaultDingTalkAccountId,
  resolveDingTalkAccount,
} from "./accounts.js";
import { PLUGIN_ID } from "./constants.js";

const channel = PLUGIN_ID;

export const DINGTALK_CREDENTIAL_HELP_LINES = [
  "1) Log in to DingTalk Open Platform: https://open.dingtalk.com",
  "2) Create an internal enterprise app -> Robot",
  "3) Get AppKey (Client ID) and AppSecret (Client Secret)",
  "4) Enable Stream mode in app configuration",
  `Docs: ${formatDocsLink(`/channels/${PLUGIN_ID}`, PLUGIN_ID)}`,
];

export const DINGTALK_ALLOWFROM_HELP_LINES = [
  "Add DingTalk user IDs that are allowed to interact with the bot.",
  "You can find user IDs in DingTalk admin panel or from bot message logs.",
  "Examples:",
  "- userId123",
  "- manager456",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink(`/channels/${PLUGIN_ID}`, PLUGIN_ID)}`,
];

/**
 * 解析钉钉 allowFrom 用户 ID
 * 钉钉用户 ID 一般是字母数字组合
 */
export function parseDingTalkAllowFromId(raw: string): string | null {
  const stripped = raw
    .trim()
    .replace(new RegExp(`^(${PLUGIN_ID}|dingtalk|dingding):`, "i"), "")
    .replace(/^user:/i, "")
    .trim();
  return /^[a-zA-Z0-9_$+-]+$/i.test(stripped) ? stripped : null;
}

/**
 * 钉钉 allowFrom 条目解析
 * 钉钉没有 API 来通过用户名查找用户 ID，所以直接使用 parseId 结果
 */
export async function resolveDingTalkAllowFromEntries(params: {
  entries: string[];
}) {
  return params.entries.map((entry) => {
    const id = parseDingTalkAllowFromId(entry);
    return { input: entry, resolved: Boolean(id), id };
  });
}

/**
 * 交互式 allowFrom 提示
 */
export async function promptDingTalkAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}) {
  const accountId =
    params.accountId ?? resolveDefaultDingTalkAccountId(params.cfg);
  const resolved = resolveDingTalkAccount({
    cfg: params.cfg,
    accountId,
  });
  await params.prompter.note(
    DINGTALK_ALLOWFROM_HELP_LINES.join("\n"),
    "DingTalk user id",
  );

  // 读取现有 allowFrom
  const existing = resolved.allowFrom ?? [];

  // 提示输入
  const entry = await params.prompter.text({
    message: "DingTalk allowFrom (user IDs)",
    placeholder: "userId1, userId2",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value: string) =>
      String(value ?? "").trim() ? undefined : "Required",
  });

  const parts = splitSetupEntries(String(entry));
  const ids = parts
    .map(parseDingTalkAllowFromId)
    .filter(Boolean) as string[];
  const unique = [...new Set([...existing.map(String), ...ids])];

  return applySetupAccountConfigPatch({
    cfg: params.cfg,
    channelKey: channel,
    accountId,
    patch: { allowFrom: unique },
  });
}

/**
 * 检查钉钉账号的凭据状态
 */
export function inspectDingTalkSetupAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
}) {
  const account = resolveDingTalkAccount(params);
  const hasClientId = Boolean(account.clientId?.trim());
  const hasClientSecret = Boolean(account.clientSecret?.trim());
  return {
    configured: hasClientId && hasClientSecret,
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    tokenSource: account.tokenSource,
    hasClientId,
    hasClientSecret,
  };
}

/**
 * 钉钉 ChannelSetupAdapter
 *
 * 钉钉使用 clientId + clientSecret 作为凭据，与 Discord/Telegram 的单 token 不同，
 * 所以不使用 createEnvPatchedAccountSetupAdapter，而是手写适配器来处理两个凭据字段。
 */
export const dingtalkSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => accountId ?? DEFAULT_ACCOUNT_ID,
  applyAccountName: ({ cfg, accountId, name }) =>
    applySetupAccountConfigPatch({
      cfg,
      channelKey: channel,
      accountId,
      patch: { name },
    }),
  validateInput: ({ input }) => {
    const typedInput = input as {
      clientId?: string;
      clientSecret?: string;
    };
    if (!typedInput.clientId && !typedInput.clientSecret) {
      return "DingTalk requires clientId and clientSecret.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      name?: string;
      clientId?: string;
      clientSecret?: string;
    };
    return applySetupAccountConfigPatch({
      cfg,
      channelKey: channel,
      accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      patch: {
        ...(typedInput.clientId ? { clientId: typedInput.clientId } : {}),
        ...(typedInput.clientSecret
          ? { clientSecret: typedInput.clientSecret }
          : {}),
      },
    });
  },
};
