/**
 * 兼容层：处理不同 OpenClaw 版本的 API 差异
 *
 * 策略：自定义精确的类型接口契约，运行时一次性解析，导出强类型符号。
 * 调用方享受完整的 TypeScript 静态检查，不会出现 any 类型污染。
 *
 * 版本差异说明：
 * - v2026.2.x ~ v2026.3.11：所有符号从 "openclaw/plugin-sdk" 主入口导出
 * - v2026.3.22+：运行时符号分散到子模块路径，类型仍从主入口导出
 */

import { createRequire } from "node:module";
import type { ZodTypeAny } from "zod";

// ============================================================================
// 类型契约：精确定义我们需要的每个符号的类型签名
// 这些类型基于 openclaw 源码中的 .d.ts 文件提取，保证与真实接口一致
// ============================================================================

/** @see openclaw/dist/plugin-sdk/channels/plugins/types.plugin.d.ts */
export type ChannelConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ChannelConfigSchema = {
  schema: Record<string, unknown>;
  uiHints?: Record<string, ChannelConfigUiHint>;
};

/** OpenClaw 配置的最小类型约束（避免直接依赖 OpenClawConfig 的子路径） */
type CfgLike = { channels?: Record<string, unknown>;[key: string]: unknown };

// 签名类型定义
type BuildChannelConfigSchemaFn = (schema: ZodTypeAny) => ChannelConfigSchema;
type NormalizeAccountIdFn = (value: string | undefined | null) => string;
type SetAccountEnabledFn = (params: {
  cfg: CfgLike; sectionKey: string; accountId: string; enabled: boolean; allowTopLevel?: boolean;
}) => CfgLike;
type DeleteAccountFn = (params: {
  cfg: CfgLike; sectionKey: string; accountId: string; clearBaseFields?: string[];
}) => CfgLike;
type ApplyAccountNameFn = (params: {
  cfg: CfgLike; channelKey: string; accountId: string; name?: string; alwaysUseAccounts?: boolean;
}) => CfgLike;
type FormatPairingApproveHintFn = (channelId: string) => string;

/** @see openclaw/dist/plugin-sdk/web/media.d.ts */
export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: string;
  fileName?: string;
};
type LoadWebMediaFn = (
  mediaUrl: string,
  maxBytesOrOptions?: number | Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<WebMediaResult>;

type MissingTargetErrorFn = (provider: string, hint?: string) => Error;

/** @see openclaw/dist/plugin-sdk/channels/session.d.ts */
type RecordInboundSessionFn = (params: {
  storePath: string;
  sessionKey: string;
  ctx: Record<string, unknown>;
  groupResolution?: unknown;
  createIfMissing?: boolean;
  updateLastRoute?: {
    sessionKey: string;
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
  };
  onRecordError: (err: unknown) => void;
}) => Promise<void>;

/** @see openclaw/dist/plugin-sdk/plugin-sdk/onboarding.d.ts */
type PromptAccountIdFn = (params: {
  cfg: CfgLike;
  prompter: unknown;
  label: string;
  currentId?: string;
  listAccountIds: (cfg: CfgLike) => string[];
  defaultAccountId: string;
}) => Promise<string>;

type EmptyPluginConfigSchemaFn = () => unknown;

// ============================================================================
// 运行时解析引擎
// ============================================================================

const require = createRequire(import.meta.url);

/**
 * 从多个模块路径中尝试加载指定符号。
 * 模块路径按优先级排列，先新版子路径，后旧版主入口。
 */
function resolve<T>(symbolName: string, modulePaths: string[], fallback: T): T {
  for (const modulePath of modulePaths) {
    try {
      const mod = require(modulePath);
      if (symbolName in mod && typeof mod[symbolName] !== "undefined") {
        return mod[symbolName] as T;
      }
    } catch {
      // 路径不存在，继续
    }
  }
  return fallback;
}

// ============================================================================
// 一次性解析所有符号（模块加载时执行，后续调用零开销）
// ============================================================================

// --- buildChannelConfigSchema ---
export const buildChannelConfigSchema: BuildChannelConfigSchemaFn = resolve(
  "buildChannelConfigSchema",
  [
    "openclaw/plugin-sdk/channel-config-schema",
    "openclaw/plugin-sdk/channel-plugin-common",
    "openclaw/plugin-sdk/core",
    "openclaw/plugin-sdk",
  ],
  ((_schema: ZodTypeAny): ChannelConfigSchema => ({
    schema: { type: "object", additionalProperties: true },
  })),
);

// --- DEFAULT_ACCOUNT_ID ---
export const DEFAULT_ACCOUNT_ID: string = resolve(
  "DEFAULT_ACCOUNT_ID",
  [
    "openclaw/plugin-sdk/channel-plugin-common",
    "openclaw/plugin-sdk/core",
    "openclaw/plugin-sdk",
  ],
  "default",
);

// --- normalizeAccountId ---
export const normalizeAccountId: NormalizeAccountIdFn = resolve(
  "normalizeAccountId",
  [
    "openclaw/plugin-sdk/channel-plugin-common",
    "openclaw/plugin-sdk/core",
    "openclaw/plugin-sdk",
  ],
  ((value?: string | null) => value?.trim() || "default"),
);

// --- setAccountEnabledInConfigSection ---
export const setAccountEnabledInConfigSection: SetAccountEnabledFn = resolve(
  "setAccountEnabledInConfigSection",
  [
    "openclaw/plugin-sdk/channel-plugin-common",
    "openclaw/plugin-sdk/core",
    "openclaw/plugin-sdk",
  ],
  ((params) => params.cfg),
);

// --- deleteAccountFromConfigSection ---
export const deleteAccountFromConfigSection: DeleteAccountFn = resolve(
  "deleteAccountFromConfigSection",
  [
    "openclaw/plugin-sdk/channel-plugin-common",
    "openclaw/plugin-sdk/core",
    "openclaw/plugin-sdk",
  ],
  ((params) => params.cfg),
);

// --- applyAccountNameToChannelSection ---
export const applyAccountNameToChannelSection: ApplyAccountNameFn = resolve(
  "applyAccountNameToChannelSection",
  [
    "openclaw/plugin-sdk/channel-plugin-common",
    "openclaw/plugin-sdk/core",
    "openclaw/plugin-sdk",
  ],
  ((params) => params.cfg),
);

// --- formatPairingApproveHint ---
export const formatPairingApproveHint: FormatPairingApproveHintFn = resolve(
  "formatPairingApproveHint",
  [
    "openclaw/plugin-sdk/channel-plugin-common",
    "openclaw/plugin-sdk",
  ],
  ((channelId: string) => `Approve pairing for ${channelId}`),
);

// --- loadWebMedia ---
export const loadWebMedia: LoadWebMediaFn = resolve(
  "loadWebMedia",
  [
    "openclaw/plugin-sdk/web-media",
    "openclaw/plugin-sdk/msteams",
    "openclaw/plugin-sdk",
  ],
  (async (_url: string) => {
    throw new Error("loadWebMedia is not available in this OpenClaw version");
  }),
);

// --- missingTargetError ---
export const missingTargetError: MissingTargetErrorFn = resolve(
  "missingTargetError",
  [
    "openclaw/plugin-sdk/channel-feedback",
    "openclaw/plugin-sdk/googlechat",
    "openclaw/plugin-sdk",
  ],
  ((provider: string, hint?: string) =>
    new Error(`Missing target for ${provider}${hint ? `. Expected: ${hint}` : ""}`)),
);

// --- recordInboundSession ---
export const recordInboundSession: RecordInboundSessionFn = resolve(
  "recordInboundSession",
  [
    "openclaw/plugin-sdk/conversation-runtime",
    "openclaw/plugin-sdk",
  ],
  (async () => { /* no-op */ }),
);

// --- promptAccountId ---
export const promptAccountId: PromptAccountIdFn = resolve(
  "promptAccountId",
  [
    "openclaw/plugin-sdk/matrix",
    "openclaw/plugin-sdk",
  ],
  (async (params) => params.currentId || params.defaultAccountId || "default"),
);

// --- emptyPluginConfigSchema ---
export const emptyPluginConfigSchema: EmptyPluginConfigSchemaFn = resolve(
  "emptyPluginConfigSchema",
  [
    "openclaw/plugin-sdk",
    "openclaw/plugin-sdk/core",
    "openclaw/plugin-sdk/channel-plugin-common",
  ],
  (() => ({ schema: {} })),
);
