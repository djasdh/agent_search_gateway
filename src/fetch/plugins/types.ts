/**
 * 取件 provider 契约（ADR-0007 / ADR-0009）。
 *
 * Provider 自管 headers / cookies / 会话与逐跳重定向，网关**不**向其传递也不干预；
 * 匹配规则由 provider 提供，网关**无条件信任**（安全边界在扩展作者，见 TODO「取件插件安全」）。
 * 产物一律走"bytes + contentType"返回，由 service 层决定落盘还是转文本。
 *
 * 契约要点：
 * - `match(url)` 只看 URL，不读配置、不抛错（注册表仍会兜底 catch）；
 * - `enabled(ctx)` 是统一的开关，禁用后注册表直接跳过，回退通用抓取；
 * - `available(ctx)` 只用于维护面（健康检查 / 列表），**不参与** `find`。
 */
import type { PluginBackends } from "../../extensions/paths.js";
import type { ChannelContext, FetchChannel } from "../channels/types.js";

export interface FetchProviderContext extends ChannelContext {
  /** 外部扩展密钥（extensions.<manifest id>.<name>，已解析 env:，空值不注入）。 */
  pluginSecrets?: Record<string, string>;
  /** 外部扩展的私有配置（extensions.<manifest id>.config；未声明 schema 时原样透传）。 */
  pluginConfig?: Readonly<Record<string, unknown>>;
  /** 外部扩展自己安装的后端；manifest 声明 backends 时注入。 */
  pluginBackends?: PluginBackends;
}

export interface FetchProviderResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  /** 二进制/文本产物；与 html 二选一。 */
  bytes?: Buffer;
  /** Provider 自行产出的 HTML（会被 html2md 渲染）。 */
  html?: string;
  errorMessage?: string;
  /** Provider 自定义错误码（如 CNKI 的 NOT_SUBSCRIBED），透传到错误文本前缀。 */
  errorCode?: string;
}

/** Provider 的能力声明（用于维护面 / 后续通道层；不影响 find）。 */
export type FetchProviderRequirement =
  | { type: "config"; path: string; optional?: boolean }
  | { type: "secret"; path: string; optional?: boolean }
  | { type: "backend"; anyOf: readonly string[]; optional?: boolean }
  | { type: "command"; path: string; default?: string; optional?: boolean };

export interface FetchProvider {
  /** 扩展 ID；由 manifest.id 覆盖。 */
  id: string;
  /** 平台 ID；从 fetch_channels 前缀派生，缺省回落到 manifest.id。 */
  platform: string;
  /** Provider 名，兼容旧日志/结果标注。 */
  name: string;
  displayName: string;
  aliases?: readonly string[];
  capabilities: readonly string[];
  requires?: readonly FetchProviderRequirement[];
  /** 该平台可用的通道（静态元数据；运行时执行仍由 provider 内部实现）。 */
  channels?: readonly FetchChannel[];

  /** 是否接管该 URL：纯 URL 判断，不读配置、不抛错。 */
  match(url: URL): boolean;
  /** 统一开关；返回 false 时注册表跳过该 provider，回退通用抓取。 */
  enabled?(ctx: FetchProviderContext): boolean;
  /** 维护面可用性（健康检查 / 列表），不参与 find。 */
  available?(ctx: FetchProviderContext): boolean;
  fetch(url: URL, ctx: FetchProviderContext): Promise<FetchProviderResult>;
}

/** 文本成功结果。 */
export function textResult(body: string, contentType: string, finalUrl?: string): FetchProviderResult {
  return {
    ok: true,
    status: 200,
    contentType,
    finalUrl,
    bytes: Buffer.from(body, "utf8"),
  };
}

/** HTML 成功结果（由 service 层做 html2md）。 */
export function htmlResult(html: string, finalUrl?: string): FetchProviderResult {
  return { ok: true, status: 200, contentType: "text/html", finalUrl, html };
}

/** 二进制成功结果。 */
export function bytesResult(bytes: Buffer, contentType: string, finalUrl?: string): FetchProviderResult {
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
): FetchProviderResult {
  const hint = extra?.hint ? `\n处理：${extra.hint}` : "";
  return {
    ok: false,
    status: extra?.status,
    finalUrl: extra?.finalUrl,
    errorCode: code,
    errorMessage: message + hint,
  };
}
