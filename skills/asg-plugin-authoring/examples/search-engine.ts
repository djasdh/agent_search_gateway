/**
 * 最小可复制的 search engine 示例（`gateway.search` 文本源）。
 *
 * 放到插件仓库的 `src/engine.ts`，入口 `src/index.ts` 里：
 *
 *   import { exampleProvider } from "./engine.js";
 *   export const engine = exampleProvider;
 *
 * `asg-extension.json` 需要 `provides: ["search"]`（与 fetch 同时存在时写
 * `["search", "fetch"]`），并用 `config_schema` 声明下面的字段。
 * 约定 manifest id 为 `example`：配置存在 `extensions.example.config`。
 */
import type {
  EngineProvider, EngineProviderContext, GatewaySearchResult,
} from "./sdk/engine.js";
import type { SearxngResult } from "./sdk/searxng.js";
import { asObject, nonEmptyString, numberOr } from "./sdk/values.js";
import { hasCategory } from "./sdk/category.js";

const DEFAULT_BASE_URL = "https://api.example.com";
const DEFAULT_CATEGORY = "example";
const DEFAULT_HOT_CATEGORY = "example_hot";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 插件私有配置。
 *
 * `ctx.pluginConfig` 已由宿主按 manifest 的 config_schema 校验并补齐默认值，
 * 这里再做一层防御式读取，方便单测直接构造不完整对象。
 */
function pluginConfig(ctx: EngineProviderContext): Readonly<Record<string, unknown>> {
  return ctx.pluginConfig ?? {};
}

function baseUrlOf(ctx: EngineProviderContext): string {
  return nonEmptyString(pluginConfig(ctx).base_url) ?? DEFAULT_BASE_URL;
}

function categoryOf(ctx: EngineProviderContext): string {
  return nonEmptyString(pluginConfig(ctx).category) ?? DEFAULT_CATEGORY;
}

function hotCategoryOf(ctx: EngineProviderContext): string {
  return nonEmptyString(pluginConfig(ctx).hot_category) ?? DEFAULT_HOT_CATEGORY;
}

function timeoutMsOf(ctx: EngineProviderContext): number {
  return numberOr(pluginConfig(ctx).timeout_ms, DEFAULT_TIMEOUT_MS);
}

interface Row {
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
  rank?: unknown;
}

/** 上游 JSON → 通用搜索结果；字段不全的行直接丢弃。 */
function mapRows(raw: unknown, limit: number): SearxngResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SearxngResult[] = [];
  for (let i = 0; i < raw.length && out.length < limit; i++) {
    const row = raw[i] as Row | null;
    if (!row || typeof row !== "object") continue;
    const url = typeof row.url === "string" ? row.url : "";
    const title = typeof row.title === "string" ? row.title : "";
    if (!url || !title) continue;
    const rank = typeof row.rank === "number" ? row.rank : i + 1;
    out.push({
      url,
      title,
      content: typeof row.snippet === "string" ? row.snippet : "",
      engine: DEFAULT_CATEGORY,
      // 排名越靠前分越高（宿主可用它做重排）。
      score: Math.max(0.5, 1 - (rank - 1) * 0.02),
    });
  }
  return out;
}

/** 调上游；所有失败都收敛成结构化错误，不抛裸异常。 */
async function callUpstream(
  query: string,
  hot: boolean,
  limit: number,
  ctx: EngineProviderContext,
): Promise<GatewaySearchResult> {
  const started = Date.now();
  const timeoutMs = timeoutMsOf(ctx);
  const url = new URL(hot ? "/hot" : "/search", baseUrlOf(ctx));
  if (!hot) url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: { kind: "api", message: `上游 HTTP ${res.status}` },
      };
    }
    const data = await res.json();
    const rows = asObject(data).results ?? data;
    return {
      ok: true,
      results: mapRows(rows, limit),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const timeout = (err as Error)?.name === "TimeoutError";
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: {
        kind: timeout ? "timeout" : "network",
        message: timeout ? `请求超时（>${timeoutMs}ms）` : (err as Error).message,
      },
    };
  }
}

export const exampleProvider: EngineProvider = {
  id: "gateway.search:example",
  group: "gateway.search",
  name: "example",
  kind: "gateway",
  displayName: "Example",
  authHint: "检查 extensions.example.config.base_url 与网络连通性。",

  // 声明本引擎负责的类别；宿主按类别分发。
  routing: (ctx) => [`category:${categoryOf(ctx)}`, `category:${hotCategoryOf(ctx)}`],

  // 私有配置由 manifest 的 config_schema 声明，不需要核心 settings/schema.ts。
  // 0.4.0 用 enabledPathV2；旧 enabledPath 只用于 0.3.x 兼容。
  enabledPathV2: ["extensions", "example", "config", "enabled"],

  // 前置条件：没有额外密钥/上游开关；用户关闭后由 enabled 处理。
  available: () => true,

  // 引擎自身开关：缺省视为启用。
  enabled: (ctx) => pluginConfig(ctx).enabled !== false,

  runtime: {
    kind: "search",

    /** plan 只做类别判断，不发请求。 */
    plan(categories, ctx) {
      const hot = hasCategory(categories, hotCategoryOf(ctx));
      const only = !hot && hasCategory(categories, categoryOf(ctx));
      return hot || only ? { hot } : undefined;
    },

    /** hot=true 时不使用 query。 */
    search(query, options, ctx) {
      return callUpstream(query, options.hot, options.limit, ctx);
    },
  },
};
