/**
 * 最小可复制的 fetch 插件示例。
 *
 * 放到插件仓库的 `src/plugin.ts`，再由 `src/index.ts` 做：
 *
 *   import { examplePlugin } from "./plugin.js";
 *   export const fetch = examplePlugin;
 *
 * 注意：入口模块一旦 `export const fetch`，该模块内的 `fetch(...)` 会解析到这个绑定，
 * 因此实现里统一用 `globalThis.fetch`（或把实现留在 plugin.ts）。
 *
 * 依赖的类型来自 `src/sdk/`（从网关复制的契约类型），不要 import 网关包。
 * 私有配置由 `asg-extension.json` 的 `config_schema` 声明，存在
 * `gateway.yaml → extensions.<manifest id>.config`，运行期读 `ctx.pluginConfig`。
 */
import type { FetchProvider, FetchProviderContext, FetchProviderResult } from "./sdk/fetch-provider.js";

const ARTICLE_PATH = /^\/article\/(\d+)(?:\/|$)/;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface ExampleConfig {
  enabled: boolean;
  timeoutMs: number;
  userAgent: string;
}

/**
 * 读取插件自己的配置。
 *
 * 宿主已按 manifest 的 `config_schema` 校验并补默认值；这里再给一层默认值，
 * 方便单测直接构造不完整的 `pluginConfig`。不要读 `ctx.settings`：那是核心内置
 * 实现的配置切片，外部插件不再依赖。
 */
function exampleConfig(ctx: FetchProviderContext): ExampleConfig {
  const conf = ctx.pluginConfig ?? {};
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

async function fetchArticle(url: URL, ctx: FetchProviderContext): Promise<FetchProviderResult> {
  const { enabled, timeoutMs, userAgent } = exampleConfig(ctx);
  if (!enabled) {
    return {
      ok: false,
      finalUrl: url.toString(),
      errorCode: "EXAMPLE_DISABLED",
      errorMessage: "example 插件未启用（extensions.example.config.enabled=false）",
    };
  }

  // 可选：密钥来自 `secrets.yaml → extensions.<manifest id>.<name>`，用
  // `asg extensions secret example --name cookie --stdin` 写入。
  const cookie = ctx.pluginSecrets?.cookie;

  let res: Response;
  try {
    // 插件自管 headers / 重定向 / 超时；这里只接受同域跳转。
    res = await globalThis.fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml",
        ...(cookie ? { cookie } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = (err as Error)?.name === "TimeoutError";
    return {
      ok: false,
      finalUrl: url.toString(),
      errorCode: timeout ? "EXAMPLE_TIMEOUT" : "EXAMPLE_NETWORK",
      errorMessage: timeout ? `请求超时（>${timeoutMs}ms）` : `请求失败：${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      status: res.status,
      finalUrl: res.url || url.toString(),
      errorCode: "EXAMPLE_HTTP",
      errorMessage: `example.com 返回 HTTP ${res.status}`,
    };
  }

  // 纯 HTML 交给宿主转 Markdown；需要结构化输出时改成 bytes + application/json。
  const html = await res.text();
  ctx.logger?.debug(`example: ${url.pathname} → ${html.length} chars`);
  return {
    ok: true,
    status: res.status,
    contentType: "text/html",
    finalUrl: res.url || url.toString(),
    html,
  };
}

export const examplePlugin: FetchProvider = {
  id: "example",
  platform: "example",
  name: "example",
  displayName: "Example",
  aliases: ["示例"],
  capabilities: ["article"],

  /** 纯 URL 判断：不读配置、不发请求、不抛错。 */
  match(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    const onHost = host === "example.com" || host.endsWith(".example.com");
    return onHost && ARTICLE_PATH.test(url.pathname);
  },

  /** 统一开关：false 时宿主回退通用抓取。 */
  enabled: (ctx) => exampleConfig(ctx).enabled,

  /** 维护面可用性：这里没有额外依赖；有密钥依赖时可读 ctx.pluginSecrets。 */
  available: () => true,

  fetch: fetchArticle,
};
