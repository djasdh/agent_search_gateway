/**
 * 取件插件契约（ADR-0007 / ADR-0009）。
 *
 * 插件自管 headers / cookies / 会话与逐跳重定向，网关**不**向其传递也不干预；
 * 匹配规则由插件提供，网关**无条件信任**（安全边界在插件作者，见 TODO「取件插件安全」）。
 * 插件产物一律走"bytes + contentType"返回，由 service 层决定落盘还是转文本。
 */
import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";

export interface FetchPluginContext {
  config: GatewayConfig;
  logger?: Logger;
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

export interface FetchPlugin {
  /** 插件名，出现在日志与结果标注里。 */
  name: string;
  /** 是否接管该 URL（先匹配、后走 generic 链）。 */
  match(url: URL): boolean;
  fetch(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult>;
}
