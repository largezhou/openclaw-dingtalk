import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk";
import type { DingTalkConfig, ResolvedDingTalkAccount } from "./types.js";

/**
 * 规范化账户 ID
 */
export function normalizeAccountId(accountId?: string | null): string {
  const normalized = accountId?.trim().toLowerCase();
  if (!normalized || normalized === "default") {
    return DEFAULT_ACCOUNT_ID;
  }
  return normalized;
}

/**
 * 列出所有钉钉账户 ID
 */
export function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const dingtalkConfig = cfg.channels?.dingtalk as DingTalkConfig | undefined;
  if (!dingtalkConfig) {
    return [];
  }

  const ids = new Set<string>();

  // 默认账户
  if (dingtalkConfig.clientId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  // 多账户
  if (dingtalkConfig.accounts) {
    for (const id of Object.keys(dingtalkConfig.accounts)) {
      ids.add(normalizeAccountId(id));
    }
  }

  return Array.from(ids);
}

/**
 * 解析默认钉钉账户 ID
 */
export function resolveDefaultDingTalkAccountId(cfg: OpenClawConfig): string {
  const ids = listDingTalkAccountIds(cfg);
  return ids.length > 0 ? ids[0] : DEFAULT_ACCOUNT_ID;
}

/**
 * 解析钉钉账户配置
 */
export function resolveDingTalkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedDingTalkAccount {
  const { cfg, accountId } = params;
  const normalizedId = normalizeAccountId(accountId);
  const dingtalkConfig = cfg.channels?.dingtalk as DingTalkConfig | undefined;

  // 默认返回值
  const defaultResult: ResolvedDingTalkAccount = {
    accountId: normalizedId,
    enabled: false,
    clientId: "",
    clientSecret: "",
    tokenSource: "none",
    config: {},
  };

  if (!dingtalkConfig) {
    return defaultResult;
  }

  // 解析默认账户
  if (normalizedId === DEFAULT_ACCOUNT_ID) {
    let clientId = "";
    let clientSecret = "";
    let tokenSource: ResolvedDingTalkAccount["tokenSource"] = "none";

    if (dingtalkConfig.clientId?.trim()) {
      clientId = dingtalkConfig.clientId.trim();
      tokenSource = "config";
    }

    if (dingtalkConfig.clientSecret?.trim()) {
      clientSecret = dingtalkConfig.clientSecret.trim();
    }

    return {
      accountId: normalizedId,
      name: dingtalkConfig.name,
      enabled: dingtalkConfig.enabled ?? true,
      clientId,
      clientSecret,
      tokenSource,
      config: {
        groups: dingtalkConfig.groups as Record<string, { requireMention?: boolean }> | undefined,
      },
    };
  }

  // 解析多账户
  const accountConfig = dingtalkConfig.accounts?.[normalizedId];
  if (!accountConfig) {
    return defaultResult;
  }

  let clientId = "";
  let clientSecret = "";
  let tokenSource: ResolvedDingTalkAccount["tokenSource"] = "none";

  if (accountConfig.clientId?.trim()) {
    clientId = accountConfig.clientId.trim();
    tokenSource = "config";
  }

  if (accountConfig.clientSecret?.trim()) {
    clientSecret = accountConfig.clientSecret.trim();
  }

  return {
    accountId: normalizedId,
    name: accountConfig.name,
    enabled: accountConfig.enabled ?? true,
    clientId,
    clientSecret,
    tokenSource,
    config: {
      groups: accountConfig.groups as Record<string, { requireMention?: boolean }> | undefined,
    },
  };
}
