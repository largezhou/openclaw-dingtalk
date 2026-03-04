import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import type {
  DingTalkConfig,
  DingTalkAccountConfig,
  ResolvedDingTalkAccount,
} from "./types.js";
import { PLUGIN_ID } from "./constants.js";

// ======================= Account List Helpers =======================

export { normalizeAccountId };

/**
 * 列出所有钉钉账号 ID
 *
 * 方案 3 策略：顶层配置和 accounts 字典共存，不做迁移。
 * - 顶层有 clientId → 视为 "default" 账号
 * - accounts 字典中的 key → 各自独立的账号
 * - 两者合并去重
 */
export function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const dingtalkConfig = cfg.channels?.[PLUGIN_ID] as DingTalkConfig | undefined;
  if (!dingtalkConfig) return [DEFAULT_ACCOUNT_ID];

  const accountKeys = Object.keys(dingtalkConfig.accounts ?? {}).filter(Boolean);

  // 顶层有凭据时，确保 "default" 在列表中
  const hasTopLevel = Boolean(dingtalkConfig.clientId?.trim());
  if (hasTopLevel && !accountKeys.includes(DEFAULT_ACCOUNT_ID)) {
    accountKeys.push(DEFAULT_ACCOUNT_ID);
  }

  if (accountKeys.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return accountKeys.slice().sort((a, b) => a.localeCompare(b));
}

/**
 * 解析默认账号 ID
 *
 * 优先使用 defaultAccount 配置，否则返回 "default"
 */
export function resolveDefaultDingTalkAccountId(cfg: OpenClawConfig): string {
  const dingtalkConfig = cfg.channels?.[PLUGIN_ID] as DingTalkConfig | undefined;
  return dingtalkConfig?.defaultAccount?.trim() || DEFAULT_ACCOUNT_ID;
}

// ======================= Account Config Resolution =======================

/**
 * 获取指定 accountId 的账户级配置（从 accounts 字典中查找）
 */
function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DingTalkAccountConfig | undefined {
  const dingtalkConfig = cfg.channels?.[PLUGIN_ID] as DingTalkConfig | undefined;
  const accounts = dingtalkConfig?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const normalized = normalizeAccountId(accountId);
  // 精确匹配或大小写不敏感匹配
  const key = Object.keys(accounts).find(
    (k) => normalizeAccountId(k) === normalized,
  );
  return key ? accounts[key] : undefined;
}

/**
 * 合并顶层配置（作为默认值）和账户级配置
 *
 * 配置优先级：账户级 > 顶层
 * 顶层的 accounts / defaultAccount 字段会被排除
 */
function mergeDingTalkAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DingTalkAccountConfig {
  const dingtalkConfig = cfg.channels?.[PLUGIN_ID] as DingTalkConfig | undefined;
  if (!dingtalkConfig) {
    return {};
  }

  // 顶层字段作为 base（排除 accounts 和 defaultAccount）
  const {
    accounts: _accounts,
    defaultAccount: _defaultAccount,
    groups: channelGroups,
    ...base
  } = dingtalkConfig;

  // 获取账户级配置
  const account = resolveAccountConfig(cfg, accountId) ?? {};

  // 多账户模式下，groups 不从顶层继承（每个账户应有自己的 groups）
  const configuredAccountIds = Object.keys(dingtalkConfig.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const groups = account.groups ?? (isMultiAccount ? undefined : channelGroups);

  return { ...base, ...account, groups };
}

// ======================= Account Resolution =======================

/**
 * 解析钉钉账户配置
 *
 * 支持两种模式：
 * 1. 单账户（旧版兼容）：顶层 clientId/clientSecret → accountId = "default"
 * 2. 多账户：accounts 字典 → 顶层字段作为默认值，账户级字段覆盖
 */
export function resolveDingTalkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDingTalkAccount {
  const accountId = normalizeAccountId(params.accountId);
  const dingtalkConfig = params.cfg.channels?.[PLUGIN_ID] as DingTalkConfig | undefined;
  const baseEnabled = dingtalkConfig?.enabled !== false;

  // 合并顶层 + 账户级配置
  const merged = mergeDingTalkAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  let clientId = "";
  let clientSecret = "";
  let tokenSource: ResolvedDingTalkAccount["tokenSource"] = "none";

  if (merged.clientId?.trim()) {
    clientId = merged.clientId.trim();
    tokenSource = "config";
  }
  if (merged.clientSecret?.trim()) {
    clientSecret = merged.clientSecret.trim();
  }

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    clientId,
    clientSecret,
    tokenSource,
    allowFrom: merged.allowFrom ?? ["*"],
    groupPolicy: merged.groupPolicy ?? "open",
    groupAllowFrom: merged.groupAllowFrom ?? [],
    groups: merged.groups ?? {},
  };
}

/**
 * 列出所有已启用的钉钉账户
 */
export function listEnabledDingTalkAccounts(
  cfg: OpenClawConfig,
): ResolvedDingTalkAccount[] {
  return listDingTalkAccountIds(cfg)
    .map((accountId) => resolveDingTalkAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
