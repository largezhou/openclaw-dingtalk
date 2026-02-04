import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelOnboardingAdapter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { DingTalkConfig } from "./types.js";
import {
  listDingTalkAccountIds,
  normalizeAccountId,
  resolveDefaultDingTalkAccountId,
  resolveDingTalkAccount,
} from "./accounts.js";

const channel = "dingtalk" as const;

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
 * Prompt for account ID selection
 */
async function promptAccountId(params: {
  cfg: OpenClawConfig;
  prompter: {
    text: (options: {
      message: string;
      placeholder?: string;
      initialValue?: string;
      validate?: (value: string | undefined) => string | undefined;
    }) => Promise<string>;
  };
  label: string;
  currentId?: string;
  listAccountIds: (cfg: OpenClawConfig) => string[];
  defaultAccountId: string;
}): Promise<string> {
  const { cfg, prompter, label, currentId, listAccountIds, defaultAccountId } = params;
  const existingIds = listAccountIds(cfg);
  const suggestions = existingIds.length > 0 ? existingIds.join(", ") : "default";

  const result = await prompter.text({
    message: `${label} account ID`,
    placeholder: suggestions,
    initialValue: currentId ?? defaultAccountId,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  return normalizeAccountId(String(result));
}

/**
 * DingTalk Onboarding Adapter
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
    accountOverrides,
    shouldPromptAccountIds,
  }) => {
    const dingtalkOverride = (accountOverrides as Record<string, string | undefined>).dingtalk?.trim();
    const defaultDingTalkAccountId = resolveDefaultDingTalkAccountId(cfg);
    let dingtalkAccountId = dingtalkOverride
      ? normalizeAccountId(dingtalkOverride)
      : defaultDingTalkAccountId;

    if (shouldPromptAccountIds && !dingtalkOverride) {
      dingtalkAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "DingTalk",
        currentId: dingtalkAccountId,
        listAccountIds: listDingTalkAccountIds,
        defaultAccountId: defaultDingTalkAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveDingTalkAccount({
      cfg: next,
      accountId: dingtalkAccountId,
    });
    const accountConfigured = Boolean(
      resolvedAccount.clientId?.trim() && resolvedAccount.clientSecret?.trim()
    );
    const dingtalkConfig = (next.channels?.dingtalk ?? {}) as DingTalkConfig;
    const hasConfigCredentials = Boolean(dingtalkConfig.clientId);

    let clientId: string | null = null;
    let clientSecret: string | null = null;

    if (!accountConfigured) {
      await noteDingTalkCredentialsHelp(prompter);
    }

    if (hasConfigCredentials) {
      const keep = await prompter.confirm({
        message: "DingTalk credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        clientId = String(
          await prompter.text({
            message: "Enter DingTalk AppKey (Client ID)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          })
        ).trim();
        clientSecret = String(
          await prompter.text({
            message: "Enter DingTalk AppSecret (Client Secret)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          })
        ).trim();
      }
    } else {
      clientId = String(
        await prompter.text({
          message: "Enter DingTalk AppKey (Client ID)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
      clientSecret = String(
        await prompter.text({
          message: "Enter DingTalk AppSecret (Client Secret)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
    }

    if (clientId && clientSecret) {
      const updatedDingtalkConfig = (next.channels?.dingtalk ?? {}) as DingTalkConfig;
      if (dingtalkAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            dingtalk: {
              ...updatedDingtalkConfig,
              enabled: true,
              clientId,
              clientSecret,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            dingtalk: {
              ...updatedDingtalkConfig,
              enabled: true,
              accounts: {
                ...updatedDingtalkConfig.accounts,
                [dingtalkAccountId]: {
                  ...updatedDingtalkConfig.accounts?.[dingtalkAccountId],
                  enabled:
                    updatedDingtalkConfig.accounts?.[dingtalkAccountId]?.enabled ?? true,
                  clientId,
                  clientSecret,
                },
              },
            },
          },
        };
      }
    }

    return { cfg: next, accountId: dingtalkAccountId };
  },
  disable: (cfg) => {
    const dingtalkConfig = (cfg.channels?.dingtalk ?? {}) as DingTalkConfig;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        dingtalk: { ...dingtalkConfig, enabled: false },
      },
    };
  },
};
