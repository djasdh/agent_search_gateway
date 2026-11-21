import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BrowserPool } from "./browser/pool.js";
import { BrowserTools } from "./browser/tools.js";
import { getSecretAtPath, ssrfOf, type GatewaySettings, type Secrets, type Settings } from "./settings/index.js";
import { fetchAdList, isAdListStale, startAdListScheduler } from "./filter/adlist.js";
import { buildDomainFilter, type DomainFilter } from "./filter/domain-filter.js";
import { createFlareSolverrClient, type FlareSolverrClient } from "./fetch/flaresolverr.js";
import { createFetchProviderRegistry } from "./fetch/plugins/index.js";
import type { FetchProviderRegistry } from "./fetch/plugins/registry.js";
import { createFetchService } from "./fetch/service.js";
import { FetchStore } from "./fetch/store.js";
import { loadExtensions } from "./extensions/loader.js";
import type { EngineProvider } from "./engines/provider.js";
import { setExternalEngineProviders } from "./engines/registry.js";
import { getHealth, type SemanticHealth } from "./health.js";
import type { Logger } from "./logger.js";
import { createSearchService } from "./search/service.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./search/embedding/provider.js";
import { createCorpusStore, type CorpusStore } from "./search/embedding/store.js";
import { mcpSessionContext } from "./utils/session-context.js";
import { GATEWAY_VERSION } from "./version.js";

export { GATEWAY_VERSION };

/** 进程启动时间：health.uptimeSec 按进程计算，而不是按 MCP 会话。 */
const PROCESS_STARTED_AT = Date.now();

/**
 * 去掉终端转义序列（playwright / locator 报错里常带 \u001b[2m 等着色码），
 * 避免把 ANSI 污染写进 agent 上下文。仅用于 browser_* 返回值包装。
 */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// 浏览器池全局单例（跨 MCP 会话共享，避免每个 session 各开浏览器进程）
let sharedBrowserPool: BrowserPool | null = null;

function getBrowserPool(settings: Settings, secrets: Secrets, logger: Logger): BrowserPool {
  if (!sharedBrowserPool) {
    sharedBrowserPool = new BrowserPool(
      {
        browser: settings.browser,
        ssrf: ssrfOf(settings.fetch),
        proxy_password: secrets.browser.proxy_password,
      },
      logger,
    );
  }
  return sharedBrowserPool;
}

// FlareSolverr 客户端全局单例：其信号量保护的是进程内的 FlareSolverr/Chromium。
// 必须跨 MCP 会话共享，否则聚合并发会变成 N × max_concurrent，Chromium 内存线性放大。
let sharedFlareSolverrClient: FlareSolverrClient | null = null;

function getFlareSolverrClient(settings: Settings): FlareSolverrClient {
  if (!sharedFlareSolverrClient) {
    sharedFlareSolverrClient = createFlareSolverrClient({
      flaresolverr: settings.flaresolverr,
      ssrf: ssrfOf(settings.fetch),
    });
  }
  return sharedFlareSolverrClient;
}

// fetch 产物存储全局单例（跨 MCP 会话共享；落盘目录与配额是进程级资源）
let sharedFetchStore: FetchStore | null = null;
let fetchStoreSweep: ReturnType<typeof setInterval> | null = null;

/** 产物 TTL/配额清扫周期（与语料库清扫同节奏）。 */
const FETCH_STORE_SWEEP_INTERVAL_MS = 3600000;

export function getFetchStore(settings: Settings, logger: Logger): FetchStore {
  if (!sharedFetchStore) {
    const fetch = settings.fetch;
    const dir = resolve(fetch.download_dir);
    sharedFetchStore = new FetchStore(dir, fetch.download_ttl_ms, fetch.download_max_total_bytes, logger);
    fetchStoreSweep = setInterval(() => {
      try {
        sharedFetchStore?.gc(Date.now());
      } catch (err) {
        logger.warn(`fetch 产物清扫失败: ${String(err)}`);
      }
    }, FETCH_STORE_SWEEP_INTERVAL_MS);
    fetchStoreSweep.unref?.();
    logger.info(`fetch 产物目录: ${dir} (TTL ${Math.round(fetch.download_ttl_ms / 86400000)}d, 配额 ${Math.round(fetch.download_max_total_bytes / 1024 / 1024)}MB)`);
  }
  return sharedFetchStore;
}

// ---- 第三方扩展：进程级单例 ----
// `createServer` 每个 MCP 会话都会调用；缓存 Promise 避免重复 import 同一插件文件。
interface SharedExtensions {
  registry: FetchProviderRegistry;
  engines: EngineProvider[];
}

let sharedExtensions: Promise<SharedExtensions> | null = null;

function getExtensions(
  settings: Settings,
  secrets: Secrets,
  logger: Logger,
): Promise<SharedExtensions> {
  if (!sharedExtensions) {
    sharedExtensions = loadExtensions(process.cwd(), {
      logger,
      extensionConfig: settings.extensions,
      extensionSecrets: secrets.extensions,
    })
      .then((loaded) => {
        for (const error of loaded.errors) {
          logger.warn(`扩展 ${error.id} 加载失败：${error.error}`);
        }
        setExternalEngineProviders(loaded.engines);
        logger.info(
          `第三方扩展已加载：fetch ${loaded.fetch.length} 个，engine ${loaded.engines.length} 个`,
        );
        return { registry: createFetchProviderRegistry(loaded.fetch), engines: loaded.engines };
      })
      .catch((err) => {
        // 加载器本身异常（非单个插件问题）时回退内置实现，不让网关启动失败。
        sharedExtensions = null;
        logger.warn(
          `第三方扩展加载失败，继续使用内置实现：${err instanceof Error ? err.message : String(err)}`,
        );
        return { registry: createFetchProviderRegistry([]), engines: [] };
      });
  }
  return sharedExtensions;
}

// ---- 广告过滤器 / adlist 调度器：进程级单例 ----
// 调度器只能有一个；过滤器由所有会话共享，刷新时只替换引用、不重建 searchService。
let sharedDomainFilter: DomainFilter | null = null;
let adListInit: Promise<void> | null = null;
let stopAdListScheduler: (() => void) | null = null;

function rebuildDomainFilter(adFilter: Settings["ad_filter"], logger: Logger): DomainFilter {
  sharedDomainFilter = buildDomainFilter(
    adFilter.enabled,
    adFilter.level,
    adFilter.extra_domains,
    adFilter.hosts_file,
    adFilter.allowlist,
  );
  if (sharedDomainFilter.enabled) {
    logger.info(`广告过滤已启用: level=${adFilter.level} 域名数=${sharedDomainFilter.count}`);
  } else {
    logger.info("广告过滤未启用 (off 或 hosts 文件缺失)");
  }
  return sharedDomainFilter;
}

/**
 * 进程级 adlist 运行时：立即用磁盘上已有的 hosts 构建过滤器并启动定期刷新；
 * 过期/缺失时的下载放到后台，**绝不阻塞 MCP 会话初始化**。
 * （慢网下 2.3MB hosts 下载曾把 initialize 拖到 30–60s，触发客户端连接超时。）
 * 由 createServer 的首次调用触发；后续会话复用同一份调度器与过滤器。
 */
function startAdListRuntime(adFilter: Settings["ad_filter"], logger: Logger): void {
  // 先用现有文件（可能为空）建过滤器，保证首个会话能立刻搜索。
  getDomainFilter(adFilter, logger);

  if (!stopAdListScheduler) {
    stopAdListScheduler = startAdListScheduler(adFilter, logger, () => {
      rebuildDomainFilter(adFilter, logger);
    });
  }

  if (adListInit) return;
  if (!adFilter.auto_update || !adFilter.enabled || adFilter.level === "off") return;
  if (!isAdListStale(adFilter)) return;

  adListInit = fetchAdList(adFilter)
    .then((ok) => {
      if (ok) {
        logger.info(`adlist 已更新: ${adFilter.hosts_file}`);
        rebuildDomainFilter(adFilter, logger);
      } else {
        logger.warn("adlist 拉取失败，使用本地/空列表");
      }
    })
    .catch((err) => {
      adListInit = null; // 异常才允许下一次会话重试；失败（返回 false）不重试，避免反复阻塞
      logger.warn(`adlist 拉取异常: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/** 每次搜索时现取当前过滤器：adlist 刷新后所有会话立即看到新值。 */
function getDomainFilter(adFilter: Settings["ad_filter"], logger: Logger): DomainFilter {
  return sharedDomainFilter ?? rebuildDomainFilter(adFilter, logger);
}

/**
 * 进程退出时统一释放进程级资源。由 index.ts 的 shutdown 调用；
 * MCP 会话内不再各自注册 SIGTERM/SIGINT 或启动调度器。
 */
export async function closeGatewayRuntime(): Promise<void> {
  if (stopAdListScheduler) {
    stopAdListScheduler();
    stopAdListScheduler = null;
  }
  adListInit = null;
  sharedDomainFilter = null;
  sharedExtensions = null;
  setExternalEngineProviders([]);
  closeSemantic();
  sharedFlareSolverrClient = null;
  const pool = sharedBrowserPool;
  sharedBrowserPool = null;
  if (pool) await pool.closeAll().catch(() => {});
}

// 语义层（embedding + 语料库）全局单例：跨 MCP 会话共享，避免每会话各开一个 sqlite 连接
interface SemanticRuntime {
  provider: EmbeddingProvider | null;
  corpus: CorpusStore | null;
  dim: number;
}

/**
 * 语义层健康快照：MCP `health` 与 HTTP `/health` 共用同一口径，
 * 避免两个入口对 embedding 状态给出相反结论。
 */
export function semanticHealthSnapshot(
  settings: Settings,
  semantic: SemanticRuntime | null,
): SemanticHealth | undefined {
  if (!semantic) return undefined;
  return {
    embeddingUp: semantic.provider !== null,
    model: settings.embedding.model || undefined,
    dim: semantic.dim || undefined,
    corpus: semantic.corpus
      ? { namespace: semantic.corpus.namespace, entries: semantic.corpus.stats().entries }
      : undefined,
  };
}

let sharedSemantic: Promise<SemanticRuntime> | null = null;
let semanticSweep: ReturnType<typeof setInterval> | null = null;
let semanticClosed = false;

async function initSemantic(settings: Settings, secrets: Secrets, logger: Logger): Promise<SemanticRuntime> {
  let provider: EmbeddingProvider | null = null;
  let dim = 0;
  const embedding = settings.embedding;
  if (embedding.enabled && embedding.model) {
    try {
      provider = createEmbeddingProvider(
        {
          provider: embedding.provider,
          baseUrl: embedding.base_url,
          apiKey: secrets.embedding.api_key,
          model: embedding.model,
          dim: embedding.dim,
          timeoutMs: embedding.timeout_ms,
          batchSize: embedding.batch_size,
          concurrency: embedding.concurrency,
          maxInputChars: embedding.max_input_chars,
          queryPrefix: embedding.query_prefix,
          passagePrefix: embedding.passage_prefix,
        },
        logger,
      );
      // 无论是否配置 dim，都做一次真实探针：验证可达性 + 维度一致
      const pr = await provider.probe();
      if (!pr.ok || !pr.dim || pr.dim <= 0) {
        throw new Error(pr.detail ?? "embedding 探针失败");
      }
      dim = pr.dim;
      logger.info(`embedding 已启用: ${embedding.provider}:${embedding.model} (dim=${dim})`);
    } catch (err) {
      logger.warn(`embedding 探针失败，已禁用语义召回: ${err instanceof Error ? err.message : String(err)}`);
      provider = null;
    }
  }

  let corpus: CorpusStore | null = null;
  const corpusSettings = settings.corpus;
  if (provider && corpusSettings.enabled) {
    try {
      const namespace = `${provider.name}:${provider.model}@${dim}`;
      corpus = createCorpusStore(
        { path: corpusSettings.store_path, namespace, dim, ttlMs: corpusSettings.ttl_ms },
        logger,
      );
      if (corpus) {
        logger.info(`语料库已启用: ${namespace} @ ${corpusSettings.store_path} (${corpus.stats().entries} 条)`);
      }
    } catch (err) {
      logger.warn(`语料库初始化失败，已禁用: ${err instanceof Error ? err.message : String(err)}`);
      corpus = null;
    }
  }

  if (corpus && !semanticSweep) {
    semanticSweep = setInterval(() => {
      try {
        const removed = corpus!.gc(Date.now());
        if (removed > 0) logger.debug(`语料库 TTL 清扫: 删除 ${removed} 条`);
      } catch (err) {
        logger.warn(`语料库清扫失败: ${String(err)}`);
      }
    }, corpusSettings.sweep_interval_ms);
    semanticSweep.unref?.();
  }

  return { provider, corpus, dim };
}

function getSemanticRuntime(settings: Settings, secrets: Secrets, logger: Logger): Promise<SemanticRuntime> {
  if (!sharedSemantic) sharedSemantic = initSemantic(settings, secrets, logger);
  return sharedSemantic;
}

function closeSemantic(): void {
  if (semanticClosed) return;
  semanticClosed = true;
  if (semanticSweep) {
    clearInterval(semanticSweep);
    semanticSweep = null;
  }
  void sharedSemantic
    ?.then((s) => {
      try {
        s.corpus?.close();
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
}

function filesBaseUrl(gateway: GatewaySettings): string {
  const host =
    gateway.host === "0.0.0.0" || gateway.host === "::" || gateway.host === "" ? "127.0.0.1" : gateway.host;
  return `http://${host}:${gateway.port}`;
}

export async function createServer(settings: Settings, secrets: Secrets, logger: Logger): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "agent-search-gateway",
      version: GATEWAY_VERSION,
    },
    {
      capabilities: { tools: {} },
    },
  );

  // 进程级资源：只初始化一次，所有 MCP 会话共享。
  // adlist 过滤器同步就绪、下载在后台进行，不让慢网阻塞会话初始化（见 startAdListRuntime）。
  startAdListRuntime(settings.ad_filter, logger);
  const semantic = await getSemanticRuntime(settings, secrets, logger);
  const browserPool = getBrowserPool(settings, secrets, logger);
  const fetchStore = getFetchStore(settings, logger);
  const flareSolverr = getFlareSolverrClient(settings);
  const extensions = await getExtensions(settings, secrets, logger);

  // searchService / fetchService 仍按会话持有（缓存与搜索并发保持会话级）；
  // 但广告过滤器通过进程级 getter 现取，fetch 共享进程级 FlareSolverr 闸门。
  const searchService = createSearchService(
    {
      search: settings.search,
      rerank: settings.rerank,
      searxng: settings.searxng,
      saucenao_api_key: secrets.search.reverse_image.saucenao.api_key,
      deepseek_api_key: secrets.search.deepseek.api_key,
    },
    () => getDomainFilter(settings.ad_filter, logger),
    logger,
    {
      embeddingProvider: semantic.provider,
      corpus: semantic.corpus,
      recallK: settings.corpus.recall_k,
    },
  );
  const fetchService = createFetchService(
    {
      fetch: settings.fetch,
      flaresolverr: settings.flaresolverr,
      browser: settings.browser,
      files_base_url: filesBaseUrl(settings.gateway),
      plugins: {
        settings: { fetch: settings.fetch },
        secrets: {},
        getSecret: (path) => getSecretAtPath(secrets, path),
        registry: extensions.registry,
      },
    },
    logger,
    browserPool,
    fetchStore,
    flareSolverr,
  );
  const browserTools = new BrowserTools(browserPool, {
    browser: settings.browser,
    ssrf: ssrfOf(settings.fetch),
  });

  server.registerTool(
    "health",
    {
      description:
        "检查网关与各后端（searxng、FlareSolverr）的连通状态。返回 JSON，包含每个后端的 up/down、延迟和错误信息。",
    },
    async () => {
      const report = await getHealth(
        { searxng: settings.searxng, flaresolverr: settings.flaresolverr, embedding: settings.embedding },
        PROCESS_STARTED_AT,
        semanticHealthSnapshot(settings, semantic),
      );
      logger.debug(`health probe: searxng=${report.searxng.status} flaresolverr=${report.flaresolverr.status}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
    },
  );

  server.registerTool(
    "search",
    {
      description:
        "搜索网页，返回 markdown 文本结果。查询会聚合多个搜索引擎（searxng），自动过滤广告/垃圾域名，并置顶直接回答/建议等元数据。指定 categories 非 general 类别（如 images、academic）时只走该类别的引擎；images 类别返回图片直链（markdown 图片），可再交给 fetch 落盘。以图搜图用 categories=search_by_image：query 给图片 URL，或改用 image_path 给本地图片路径；会并发走 searxng 的 tineye 与网关侧附加源（trace.moe 动画截图、SauceNAO 插画出处、百度识图中文图），候选按 URL 合并去重。本地图会发布到公网图床以喂 tineye，见 README。\n\n" +
        "平台能力由第三方扩展提供：安装对应扩展后，扩展注册的 categories 与抓取通道会自动生效；未安装时该类别会判为未知。",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("搜索关键词；以图搜图时可直接给图片 URL（http/https），与 image_path 二选一"),
        image_path: z
          .string()
          .optional()
          .describe("以图搜图：本地图片路径（网关可读），与 query 里的图片 URL 二选一；需配合 categories=search_by_image"),
        language: z.string().optional().describe("语言代码，如 en/zh-CN，默认按 searxng 实例"),
        safesearch: z.enum(["0", "1", "2"]).optional().describe("安全搜索：0 无/1 中/2 严"),
        categories: z.string().optional().describe("搜索类别，逗号分隔，如 general,news；images（图片直链）、science（学术）、search_by_image（以图搜图）；扩展注册的类别也可以直接使用"),
        engines: z.string().optional().describe("指定搜索引擎，逗号分隔"),
        min_score: z.number().min(0).max(1).optional().describe("最低相关度分数 0-1"),
        num_results: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("返回结果条数上限（系统单一上限见 search.max_results_cap；超出按上限截断，不报错）"),
        fanout: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("扇出引擎数量：同时查询的引擎家数（默认 1，仅一家；无结果/不可用时自动静默降级换下一家）"),
      },
    },
    async (args) => {
      const result = await searchService.search({
        query: args.query ?? "",
        imagePath: args.image_path,
        language: args.language,
        safeSearch: args.safesearch,
        categories: args.categories,
        engines: args.engines,
        fanout: args.fanout,
        minScore: args.min_score,
        numResults: args.num_results,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
      };
    },
  );

  server.registerTool(
    "fetch",
    {
      description:
        "抓取一个 URL。网页（HTML）转 markdown；纯文本/JSON/CSV/XML 直接返回；PDF 抽取正文；图片等二进制文件落盘并返回本地路径与 /files/<id> 下载链接（正文不注入上下文）。网页正文为空或疑似 JS 渲染时会自动升级浏览器渲染（render=auto，默认）；render=always 强制走浏览器，render=never 关闭。\n\n" +
        "平台能力由第三方扩展提供：安装对应扩展后，扩展会按 URL 接管抓取，并可能支持额外的 URL 参数；具体说明见扩展文档。",
      inputSchema: {
        url: z.string().url().describe("要抓取的网页 URL；扩展可能支持额外的 URL 参数（见扩展文档）"),
        max_chars: z
          .number()
          .int()
          .positive()
          .max(200000)
          .optional()
          .describe("输出 markdown 最大字符数（上限 200000）"),
        render: z
          .enum(["auto", "always", "never"])
          .optional()
          .describe(
            "浏览器渲染策略：auto（默认，正文为空/疑似 JS 时自动升级）、always（强制渲染）、never（不渲染）",
          ),
      },
    },
    async (args) => {
      const result = await fetchService.fetch({
        url: args.url,
        maxChars: args.max_chars,
        render: args.render,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
      };
    },
  );

  // ---- browser_* 工具（agent 交互，透明转发到内嵌 playwright） ----
  const browserResultContent = (r: Awaited<ReturnType<BrowserTools["snapshot"]>>) => {
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
    if (r.screenshot) {
      content.push({ type: "image", data: r.screenshot.base64, mimeType: r.screenshot.mimeType });
    }
    if (r.error) {
      content.push({ type: "text" as const, text: `错误：${stripAnsi(r.error)}` });
      return { content, isError: true };
    }
    if (r.text) {
      content.push({ type: "text" as const, text: stripAnsi(r.text) });
    }
    return { content };
  };

  if (browserPool.enabled) {
    server.registerTool(
      "browser_navigate",
      {
        description: "在浏览器中打开一个 URL，返回页面无障碍树快照（结构化内容，省 token）。用于操作复杂 JS 页面。",
        inputSchema: { url: z.string().url().describe("要打开的 URL") },
      },
      async (args) => browserResultContent(await browserTools.navigate(args.url)),
    );

    server.registerTool(
      "browser_snapshot",
      {
        description: "获取当前页面的无障碍树快照。可选 target 选择器限定范围。",
        inputSchema: { target: z.string().optional().describe("CSS 选择器，限定快照范围") },
      },
      async (args) => browserResultContent(await browserTools.snapshot(args.target)),
    );

    server.registerTool(
      "browser_take_screenshot",
      {
        description: "对当前页面截图，返回 base64 图片。",
        inputSchema: {},
      },
      async () => browserResultContent(await browserTools.takeScreenshot()),
    );

    server.registerTool(
      "browser_click",
      {
        description: "点击页面元素（CSS 选择器），返回点击后的无障碍树快照。",
        inputSchema: { target: z.string().describe("要点击的元素 CSS 选择器") },
      },
      async (args) => browserResultContent(await browserTools.click(args.target)),
    );

    server.registerTool(
      "browser_type",
      {
        description: "在输入框（CSS 选择器）中输入文本，返回输入后的无障碍树快照。",
        inputSchema: {
          target: z.string().describe("输入框 CSS 选择器"),
          text: z.string().describe("要输入的文本"),
        },
      },
      async (args) => browserResultContent(await browserTools.type(args.target, args.text)),
    );

    server.registerTool(
      "browser_scroll",
      {
        description: "滚动页面（up/down/top/bottom），返回滚动后的无障碍树快照。",
        inputSchema: { direction: z.enum(["up", "down", "top", "bottom"]).describe("滚动方向") },
      },
      async (args) => browserResultContent(await browserTools.scroll(args.direction)),
    );

    server.registerTool(
      "browser_find",
      {
        description: "在当前页面的无障碍树中搜索文本，返回匹配片段。",
        inputSchema: { text: z.string().describe("要搜索的文本") },
      },
      async (args) => browserResultContent(await browserTools.find(args.text)),
    );

    server.registerTool(
      "browser_close",
      {
        description: "关闭当前浏览器会话页面。",
        inputSchema: {},
      },
      async () => browserResultContent(await browserTools.close()),
    );
  }

  return server;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeenAt: number;
  /**
   * 打开中的 GET /mcp SSE 流数量（SDK 每会话只允许一条，实际是 0/1）。
   * 客户端不调工具时唯一的存活信号就是这条长连接，>0 时不能参与空闲清扫。
   */
  openStreams: number;
}

/**
 * session 空闲过期：客户端崩溃/断连不发 DELETE 时回收 transport +
 * 浏览器上下文，防 sessions Map 无限增长。客户端正常重连会重新
 * initialize，不受影响。
 *
 * 注意「活动」包括 GET /mcp 的 SSE 长连接：客户端可能挂流一整小时
 * 不发任何 POST，只按 lastSeenAt 判断会把它当成殭尸会话删掉。
 */
const SESSION_IDLE_TTL_MS = 60 * 60 * 1000; // 1 小时无活动
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟扫一次

function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    (body as { method?: unknown }).method === "initialize"
  );
}

/** POST body 上限（MCP 请求都很小，1MB 足够；防超大 body 打满内存） */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * readJsonBody 的失败原因：调用方据此选择 HTTP 状态码与 JSON-RPC 错误码。
 * 内部类型，不对外暴露（startHttpServer / createServer 签名不变）。
 */
type BodyReadErrorKind = "invalid_json" | "too_large" | "read_error";

class BodyReadError extends Error {
  readonly kind: BodyReadErrorKind;

  constructor(kind: BodyReadErrorKind, message: string) {
    super(message);
    this.name = "BodyReadError";
    this.kind = kind;
  }
}

function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    // 'end' 之后 'close' 也会触发，用它区分「已被读取失败」与「客户端中途断开」。
    let settled = false;

    const fail = (err: BodyReadError): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (c) => {
      if (settled) return;
      received += (c as Buffer).byteLength;
      if (received > MAX_BODY_BYTES) {
        // 不再累积；暂停读取，让调用方先回 413 再结束连接（直接 destroy 会让响应写不出去）。
        req.pause();
        fail(new BodyReadError("too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(c as Buffer);
    });
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        settled = true;
        resolve(undefined);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        settled = true;
        resolve(parsed);
      } catch {
        fail(new BodyReadError("invalid_json", "invalid JSON body"));
      }
    });
    req.on("error", (err) => {
      fail(new BodyReadError("read_error", err instanceof Error ? err.message : String(err)));
    });
    // 客户端未发完 body 就断开（典型：Content-Length 大于实际发送量）时不会再触发 end，
    // 必须在这里收尾，否则 Promise 永不落定、请求悬挂。
    req.on("aborted", () => {
      fail(new BodyReadError("read_error", "request aborted before body end"));
    });
    req.on("close", () => {
      if (!settled && !req.complete) {
        fail(new BodyReadError("read_error", "request closed before body end"));
      }
    });
  });
}

function writeJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startHttpServer(
  deps: {
    settings: Settings;
    secrets: Secrets;
    logger: Logger;
    /** 测试用：覆盖空闲 TTL / 清扫间隔，默认沿用常量。 */
    sessionIdleTtlMs?: number;
    sessionSweepIntervalMs?: number;
  },
  createMcpServer: (settings: Settings, secrets: Secrets, logger: Logger) => Promise<McpServer>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { settings, secrets, logger } = deps;
  const idleTtlMs = deps.sessionIdleTtlMs ?? SESSION_IDLE_TTL_MS;
  const sweepIntervalMs = deps.sessionSweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS;
  const { createServer: createHttp } = await import("node:http");

  const sessions = new Map<string, Session>();
  let shutdown = false;
  // session 结束时同步清理对应的浏览器上下文（context/page），防泄漏
  const releaseBrowserSession = (sessionId: string) => {
    const pool = sharedBrowserPool;
    if (!pool) return;
    void mcpSessionContext.run(sessionId, () => pool.closeSession()).catch(() => {});
  };

  const httpServer = createHttp(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // 健康检查端点（不经 MCP）
    if (url.pathname === "/health" && req.method === "GET") {
      // 语义层是进程级单例：首次 /health 会触发一次探针，之后直接复用结果。
      // 这样探针与 MCP health 看到同一份 embedding 状态，不会一边 up 一边 down。
      const semantic = await getSemanticRuntime(settings, secrets, logger);
      const report = await getHealth(
        { searxng: settings.searxng, flaresolverr: settings.flaresolverr, embedding: settings.embedding },
        PROCESS_STARTED_AT,
        semanticHealthSnapshot(settings, semantic),
      );
      writeJson(res, 200, report);
      return;
    }

    // 产物下载端点（公开：id 是内容 sha256，不可猜；见 ADR-0009）
    if (settings.fetch.files_route && req.method === "GET" && url.pathname.startsWith("/files/")) {
      const id = decodeURIComponent(url.pathname.slice("/files/".length));
      const store = getFetchStore(settings, logger);
      const ref = store.get(id);
      const stream = ref ? store.openReadStream(id) : undefined;
      if (!ref || !stream) {
        writeJson(res, 404, { error: "not found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": ref.contentType,
        "Content-Length": String(ref.size),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="${ref.id}${ref.ext}"`,
      });
      stream.on("error", (err) => {
        logger.warn(`/files 读取失败: ${id} ${String(err)}`);
        if (!res.headersSent) writeJson(res, 500, { error: "read error" });
        else res.end();
      });
      stream.pipe(res);
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "not found" });
      return;
    }

    // 可选 Bearer token 认证
    if (secrets.gateway.token && req.headers.authorization !== `Bearer ${secrets.gateway.token}`) {
      writeJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }

    const method = req.method ?? "GET";

    if (method === "POST") {
      const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;

      // 读取失败必须就地回错误并结束：rejection 若继续向上冒泡会被进程级
      // unhandledRejection 吞掉，请求永不返回、socket 泄漏。
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const kind = err instanceof BodyReadError ? err.kind : "read_error";
        if (kind === "too_large") {
          writeJson(
            res,
            413,
            { jsonrpc: "2.0", error: { code: -32600, message: "Request body too large" }, id: null },
            { Connection: "close" },
          );
          // 继续读出并丢弃剩余数据：直接把 socket 掐掉会让客户端在读到 413 前遇到 RST。
          // 不累积到内存，仅排空；卡住的连接由 requestTimeout 兜底。
          req.resume();
        } else if (kind === "invalid_json") {
          writeJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          });
        } else {
          logger.warn(`read request body failed: ${err instanceof Error ? err.message : String(err)}`);
          writeJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32600, message: "Bad Request: cannot read request body" },
            id: null,
          });
        }
        return;
      }

      let transport: StreamableHTTPServerTransport;
      let mcpServer: McpServer;

      if (sessionId && sessions.has(sessionId)) {
        const s = sessions.get(sessionId)!;
        s.lastSeenAt = Date.now();
        transport = s.transport;
        mcpServer = s.server;
        logger.debug(`reusing session: ${sessionId}`);
      } else if (isInitializeRequest(body)) {
        mcpServer = await createMcpServer(settings, secrets, logger);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, {
              transport,
              server: mcpServer,
              lastSeenAt: Date.now(),
              openStreams: 0,
            });
            logger.debug(`session initialized: ${sid}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            releaseBrowserSession(transport.sessionId);
          }
        };
        await mcpServer.connect(transport);
      } else {
        // 无有效 session 且非 initialize
        writeJson(res, sessionId ? 404 : 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: missing or invalid session" },
          id: null,
        });
        return;
      }

      try {
        // 注入 sessionId 到 AsyncLocalStorage：browser_* 工具据此隔离上下文
        await mcpSessionContext.run(sessionId ?? undefined, () =>
          transport.handleRequest(req, res, body),
        );
      } catch (err) {
        logger.error(`transport handleRequest failed: ${String(err)}`);
        if (!res.headersSent) {
          writeJson(res, 500, { error: "internal error" });
        }
      }
      return;
    }

    if (method === "GET") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const s = sessionId ? sessions.get(sessionId) : undefined;
      if (!s) {
        // 带 id 但不认识 → 404（会话已失效，规范要求 404）；完全没 id → 400
        writeJson(res, sessionId ? 404 : 400, { error: "invalid or missing session id" });
        return;
      }

      // GET /mcp 就是客户端的长活心跳：开流即视为活动，关流后再给一个
      // 完整 TTL。openStreams > 0 的会话不参与空闲清扫（见下方 sweep）。
      s.lastSeenAt = Date.now();
      s.openStreams += 1;
      res.once("close", () => {
        s.openStreams = Math.max(0, s.openStreams - 1);
        s.lastSeenAt = Date.now();
      });

      try {
        await mcpSessionContext.run(sessionId, () =>
          s.transport.handleRequest(req, res, undefined),
        );
      } catch (err) {
        logger.error(`GET /mcp failed: ${String(err)}`);
        if (!res.headersSent) {
          writeJson(res, 500, { error: "internal error" });
        }
      }
      return;
    }

    if (method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        writeJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: missing session id" },
          id: null,
        });
        return;
      }
      if (!sessions.has(sessionId)) {
        writeJson(res, 404, { error: "session not found" });
        return;
      }
      const s = sessions.get(sessionId)!;
      sessions.delete(sessionId);
      releaseBrowserSession(sessionId);
      try {
        await s.transport.close();
      } catch (err) {
        logger.warn(`error closing session transport: ${String(err)}`);
      }
      logger.debug(`session deleted: ${sessionId}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    writeJson(res, 405, { error: "method not allowed" }, { Allow: "GET, POST, DELETE" });
  });

  // 读取超时：requestTimeout 限制「收完整个请求」的时长，headersTimeout 限制头部到达；
  // 这样 Content-Length 大于实际 body / 半开连接不会无限占用 socket。
  // 注意：二者只作用于请求接收阶段，不影响 GET /mcp 的 SSE 长响应。
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(settings.gateway.port, settings.gateway.host, () => resolve());
  });

  // 空闲 session 清扫：只回收「没有活的 SSE 流」且空闲超过 TTL 的会话。
  // 注意不要在这里 transport.close()：它会把客户端流优雅结束、触发客户端
  // 重连 churn；真正要回收的只是 sessions 这条强引用（以及显式释放的浏览器
  // 上下文），transport/server 图脱离了 Map 就会被 GC。
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (s.openStreams > 0) continue;
      if (now - s.lastSeenAt <= idleTtlMs) continue;
      sessions.delete(sid);
      releaseBrowserSession(sid);
      logger.info(`session expired (idle ${Math.round((now - s.lastSeenAt) / 1000)}s): ${sid}`);
    }
  }, sweepIntervalMs);
  sweep.unref?.();

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : settings.gateway.port;
  logger.info(`gateway listening on http://${settings.gateway.host}:${port}/mcp`);

  return {
    url: `http://${settings.gateway.host}:${port}/mcp`,
    close: async () => {
      shutdown = true;
      clearInterval(sweep);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      for (const [, s] of sessions) {
        try {
          await s.transport.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
    },
  };
}
