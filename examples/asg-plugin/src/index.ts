/**
 * 示例抓取插件（V2 FetchProvider）。
 *
 * 约定：不 import 网关内部模块，只导出运行期约定的命名导出 `fetch`。
 * 私有配置由 `asg-extension.json` 的 `config_schema` 声明；运行期从
 * `ctx.pluginConfig` 读取（宿主已补默认值并冻结），密钥从 `ctx.pluginSecrets` 读取。
 * 平台/通道身份由 manifest 的 `fetch_channels` 声明，入口不再写 V1 的 `platform`。
 */

export interface ExampleFetchContext {
  /** `gateway.yaml → extensions.example-fetch.config`，已按 config_schema 补默认值。 */
  pluginConfig?: Readonly<Record<string, unknown>>;
  /** `secrets.yaml → extensions.example-fetch.<name>`，已解析 env:。 */
  pluginSecrets?: Record<string, string>;
  logger?: { debug(message: string): void };
}

export interface ExampleFetchResult {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = "asg-example-fetch/0.1";

interface ExampleConfig {
  enabled: boolean;
  timeoutMs: number;
  userAgent: string;
}

/** 配置读取集中在这里；字段缺失时回落到示例默认值。 */
function exampleConfig(ctx?: ExampleFetchContext): ExampleConfig {
  const conf = ctx?.pluginConfig ?? {};
  return {
    enabled: conf.enabled !== false,
    timeoutMs:
      typeof conf.timeout_ms === "number" && Number.isFinite(conf.timeout_ms)
        ? conf.timeout_ms
        : DEFAULT_TIMEOUT_MS,
    userAgent:
      typeof conf.user_agent === "string" && conf.user_agent.trim().length > 0
        ? conf.user_agent
        : DEFAULT_USER_AGENT,
  };
}

export const fetch = {
  id: "example-fetch",
  platform: "example",
  name: "example-fetch",
  displayName: "Example Fetch Extension",
  capabilities: ["html"],

  /**
   * 可选运行时通道元数据；id 集合必须与 manifest 的 fetch_channels 一致。
   * 不导出时 manifest 的 fetch_channels 只用于展示与 platform 派生。
   */
  channels: [
    {
      id: "example:http",
      platform: "example",
      channel: "http",
      displayName: "Example HTTP",
      kind: "http",
      capabilities: ["html"],
    },
  ],

  /** 只做纯 URL 判断，不读配置、不抛错。 */
  match(url: URL): boolean {
    return url.hostname === "example.com" || url.hostname.endsWith(".example.com");
  },

  /** 总开关；false 时宿主回退通用抓取。 */
  enabled(ctx?: ExampleFetchContext): boolean {
    return exampleConfig(ctx).enabled;
  },

  /** 维护面可用性：本示例没有额外依赖。 */
  available(): boolean {
    return true;
  },

  async fetch(url: URL, ctx?: ExampleFetchContext): Promise<ExampleFetchResult> {
    const { enabled, timeoutMs, userAgent } = exampleConfig(ctx);
    if (!enabled) {
      return {
        ok: false,
        finalUrl: url.href,
        errorCode: "EXAMPLE_DISABLED",
        errorMessage: "example 插件未启用（extensions.example-fetch.config.enabled=false）",
      };
    }

    // 密钥示例：`asg extensions secret example-fetch --name cookie --stdin`。
    const cookie = ctx?.pluginSecrets?.cookie;
    ctx?.logger?.debug(
      `example: ${url.pathname} (timeout_ms=${timeoutMs}, cookie=${cookie ? "set" : "unset"})`,
    );

    // 真实插件会用 timeoutMs / userAgent / cookie 发起请求；示例只返回固定 HTML。
    return {
      ok: true,
      html: `<html><body><h1>example</h1><p>${url.href}</p><p>timeout_ms=${timeoutMs}</p><p>user_agent=${userAgent}</p></body></html>`,
      finalUrl: url.href,
    };
  },
};
