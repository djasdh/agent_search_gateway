/**
 * 取件插件契约（ADR-0007 / ADR-0009）。
 *
 * 插件自管 headers / cookies / 会话与逐跳重定向，网关**不**向其传递也不干预；
 * 匹配规则由插件提供，网关**无条件信任**（安全边界在插件作者，见 TODO「取件插件安全」）。
 * 插件产物一律走"bytes + contentType"返回，由 service 层决定落盘还是转文本。
 *
 * 契约要点：
 * - `match(url)` 只看 URL，不读配置、不抛错（注册表仍会兜底 catch）；
 * - `enabled(ctx)` 是统一的开关，禁用后注册表直接跳过，回退通用抓取；
 * - `available(ctx)` 只用于维护面（健康检查 / 列表），**不参与** `find`。
 */
import type { ChannelContext, FetchChannel } from "../channels/types.js";

export interface FetchPluginContext extends ChannelContext {
  /** 外部插件的自定义配置（内置插件通常不用）。 */
  pluginConfig?: unknown;
}

export interface FetchPluginResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  /** 二进制/文本产物；与 html 二选一。 */
  bytes?: Buffer;
  /** 插件自行产出的 HTML（会被 html2md 渲染）。 */
  html?: string;
  errorMessage?: string;
  /** 插件自定义错误码（如 CNKI 的 NOT_SUBSCRIBED），透传到错误文本前缀。 */
  errorCode?: string;
}

/** 插件的能力声明（用于维护面 / 后续通道层；不影响 find）。 */
export type FetchPluginRequirement =
  | { type: "config"; path: string; optional?: boolean }
  | { type: "secret"; path: string; optional?: boolean }
  | { type: "backend"; anyOf: readonly string[]; optional?: boolean }
  | { type: "command"; path: string; default?: string; optional?: boolean };

export interface FetchPlugin {
  /** 规范平台 ID（见 `src/fetch/platforms.ts`）。 */
  id: string;
  /** 与 id 相同，保留给按平台分组的调用方。 */
  platform: string;
  /** 插件名，兼容旧日志/结果标注。 */
  name: string;
  displayName: string;
  aliases?: readonly string[];
  /** 对应设置段（如 `bilibili`）。 */
  settingsKey?: string;
  capabilities: readonly string[];
  requires?: readonly FetchPluginRequirement[];
  /** 该平台可用的通道（静态元数据；运行时执行仍由插件内部实现）。 */
  channels?: readonly FetchChannel[];

  /** 是否接管该 URL：纯 URL 判断，不读配置、不抛错。 */
  match(url: URL): boolean;
  /** 统一开关；返回 false 时注册表跳过该插件，回退通用抓取。 */
  enabled?(ctx: FetchPluginContext): boolean;
  /** 维护面可用性（健康检查 / 列表），不参与 find。 */
  available?(ctx: FetchPluginContext): boolean;
  fetch(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult>;
}

/** 文本成功结果。 */
export function textResult(body: string, contentType: string, finalUrl?: string): FetchPluginResult {
  return {
    ok: true,
    status: 200,
    contentType,
    finalUrl,
    bytes: Buffer.from(body, "utf8"),
  };
}

/** HTML 成功结果（由 service 层做 html2md）。 */
export function htmlResult(html: string, finalUrl?: string): FetchPluginResult {
  return { ok: true, status: 200, contentType: "text/html", finalUrl, html };
}

/** 二进制成功结果。 */
export function bytesResult(bytes: Buffer, contentType: string, finalUrl?: string): FetchPluginResult {
  return { ok: true, status: 200, contentType, finalUrl, bytes };
}

/**
 * 失败结果。
 *
 * 有 `hint` 时按现有微博风格追加 `\n处理：<hint>`，agent 可直接照做。
 */
export function errorResult(
  code: string | undefined,
  message: string,
  extra?: { status?: number; finalUrl?: string; hint?: string },
): FetchPluginResult {
  const hint = extra?.hint ? `\n处理：${extra.hint}` : "";
  return {
    ok: false,
    status: extra?.status,
    finalUrl: extra?.finalUrl,
    errorCode: code,
    errorMessage: message + hint,
  };
}
