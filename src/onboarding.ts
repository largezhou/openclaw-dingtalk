import type { ChannelOnboardingAdapter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, promptAccountId } from "openclaw/plugin-sdk";
import type { DingTalkConfig } from "./types.js";
import {
  listDingTalkAccountIds,
  resolveDefaultDingTalkAccountId,
  resolveDingTalkAccount,
} from "./accounts.js";
import { PLUGIN_ID } from "./constants.js";

const channel = PLUGIN_ID;

/**
 * Display DingTalk credentials configuration help
 */
async function noteDingTalkCredentialsHelp(prompter: {
  note: (message: string, title?: string) => Promise<void>;
}): Promise<void> {
  await prompter.note(
    [
      "1) Log in to DingTalk Open Platform: https://open.dingtalk.com",
      "2) Create an internal enterprise app -> Robot",
      "3) Get AppKey (Client ID) and AppSecret (Client Secret)",
      "4) Enable Stream mode in app configuration",
      "Docs: https://open.dingtalk.com/document/",
    ].join("\n"),
    "DingTalk bot setup"
  );
}

/**
 * Prompt for DingTalk credentials (clientId + clientSecret)
 */
async function promptDingTalkCredentials(prompter: {
  text: (opts: { message: string; validate?: (value: string) => string | undefined }) => Promise<string | symbol>;
}): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = String(
    await prompter.text({
      message: "Enter DingTalk AppKey (Client ID)",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
  const clientSecret = String(
    await prompter.text({
      message: "Enter DingTalk AppSecret (Client Secret)",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
  return { clientId, clientSecret };
}

/** 需要从顶层迁移到 accounts.default 的字段 */
const ACCOUNT_LEVEL_KEYS = new Set([
  "name",
  "clientId",
  "clientSecret",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "groups",
]);

/**
 * 当添加非 default 账号时，把顶层的账号级字段迁移到 accounts.default 下。
 * 如果 accounts 字典已存在（已经是多账号模式），则不做迁移。
 */
function moveTopLevelToDefaultAccount(
  section: DingTalkConfig,
): DingTalkConfig {
  // 已有 accounts 字典，不需要迁移
  if (section.accounts && Object.keys(section.accounts).length > 0) {
    return section;
  }

  const defaultAccount: Record<string, unknown> = {};
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(section)) {
    if (key === "accounts" || key === "defaultAccount") {
      cleaned[key] = value;
    } else if (ACCOUNT_LEVEL_KEYS.has(key) && value !== undefined) {
      defaultAccount[key] = value;
      // 不复制到 cleaned，从顶层移除
    } else {
      cleaned[key] = value;
    }
  }

  // 没有可迁移的字段
  if (Object.keys(defaultAccount).length === 0) {
    return section;
  }

  return {
    ...cleaned,
    accounts: {
      [DEFAULT_ACCOUNT_ID]: defaultAccount,
    },
  } as DingTalkConfig;
}

/**
 * Apply credentials to the config for a given accountId.
 *
 * 策略（与框架层 Discord/Telegram 一致）：
 * - default 账号：写顶层（兼容单账号模式）
 * - 非 default 账号：先把顶层账号级字段迁移到 accounts.default，再写 accounts[accountId]
 */
function applyCredentials(
  cfg: Record<string, unknown>,
  accountId: string,
  credentials: { clientId: string; clientSecret: string }
): Record<string, unknown> {
  const dingtalkConfig = ((cfg.channels as Record<string, unknown>)?.[PLUGIN_ID] ?? {}) as DingTalkConfig;

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // default 账号：写顶层
    return {
      ...cfg,
      channels: {
        ...(cfg.channels as Record<string, unknown>),
        [PLUGIN_ID]: {
          ...dingtalkConfig,
          enabled: true,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
        },
      },
    };
  }

  // 非 default 账号：先迁移顶层到 accounts.default，再写新账号
  const migrated = moveTopLevelToDefaultAccount(dingtalkConfig);

  return {
    ...cfg,
    channels: {
      ...(cfg.channels as Record<string, unknown>),
      [PLUGIN_ID]: {
        ...migrated,
        enabled: true,
        accounts: {
          ...migrated.accounts,
          [accountId]: {
            ...migrated.accounts?.[accountId],
            enabled: true,
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
          },
        },
      },
    },
  };
}

/**
 * DingTalk Onboarding Adapter（支持多账号）
 */
export const dingtalkOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listDingTalkAccountIds(cfg).some((accountId) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      return Boolean(account.clientId?.trim() && account.clientSecret?.trim());
    });
    return {
      channel,
      configured,
      statusLines: [`DingTalk: ${configured ? "configured" : "needs credentials"}`],
      selectionHint: configured ? "configured" : "needs AppKey/AppSecret",
      quickstartScore: configured ? 1 : 5,
    };
  },
  configure: async ({
    cfg,
    prompter,
    shouldPromptAccountIds,
    accountOverrides,
  }) => {
    let next = cfg;

    // 1. 解析 accountId：支持多账号选择 / 添加新账号
    const defaultAccountId = resolveDefaultDingTalkAccountId(cfg);
    const override = accountOverrides?.[PLUGIN_ID]?.trim();
    let accountId = override ?? defaultAccountId;

    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "DingTalk",
        currentId: accountId,
        listAccountIds: listDingTalkAccountIds,
        defaultAccountId,
      });
    }

    // 2. 检查该账号自身是否已配置凭据（不继承顶层，避免新账号误判为已配置）
    const accountConfigured = (() => {
      const dingtalkSection = (next.channels as Record<string, unknown>)?.[PLUGIN_ID] as DingTalkConfig | undefined;
      if (!dingtalkSection) return false;
      // 检查 accounts[accountId] 自身
      const acct = dingtalkSection.accounts?.[accountId];
      if (acct?.clientId?.trim() && acct?.clientSecret?.trim()) return true;
      // default 账号额外兼容顶层旧配置（手动编辑或旧版迁移）
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return Boolean(dingtalkSection.clientId?.trim() && dingtalkSection.clientSecret?.trim());
      }
      return false;
    })();

    // 3. 凭据输入
    if (!accountConfigured) {
      await noteDingTalkCredentialsHelp(prompter);
      const credentials = await promptDingTalkCredentials(prompter);
      next = applyCredentials(next, accountId, credentials) as typeof next;
    } else {
      const keep = await prompter.confirm({
        message: "DingTalk credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        const credentials = await promptDingTalkCredentials(prompter);
        next = applyCredentials(next, accountId, credentials) as typeof next;
      }
    }

    return { cfg: next, accountId };
  },
  disable: (cfg) => {
    const dingtalkConfig = (cfg.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [PLUGIN_ID]: { ...dingtalkConfig, enabled: false },
      },
    };
  },
};
