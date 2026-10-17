import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";

/** 展开路径开头的 `~` 为当前用户 home（配置文件里的可读写法）。 */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * 引擎清单：新格式为分档对象 `{ resident, rotating }`；
 * 旧格式为平铺数组（等价于「全部轮换」，resident 为空）。
 */
const enginesSchema = z.union([
  z.array(z.string()),
  z.object({
    resident: z.array(z.string()).default([]),
    rotating: z.array(z.string()).default([]),
  }),
]);

const configSchema = z.object({
  gateway: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().max(65535).default(3000),
    token: z.string().default(""),
  }),
  logging: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
      file: z.string().default(""),
    })
    .catch({ level: "info", file: "" }),
  searxng: z
    .object({
      url: z.string().url().default("http://127.0.0.1:8888"),
      timeout_ms: z.number().int().positive().default(10000),
    })
    .catch({ url: "http://127.0.0.1:8888", timeout_ms: 10000 }),
  flaresolverr: z
    .object({
      url: z.string().url().default("http://127.0.0.1:8192"),
      enabled: z.boolean().default(true),
      timeout_ms: z.number().int().positive().default(60000),
      max_concurrent: z.number().int().positive().max(16).default(2),
      trigger_status: z.array(z.number().int().positive()).default([403, 405, 429]),
      fallback_on_empty: z.boolean().default(true),
    })
    .catch({
      url: "http://127.0.0.1:8192",
      enabled: true,
      timeout_ms: 60000,
      max_concurrent: 2,
      trigger_status: [403, 405, 429],
      fallback_on_empty: true,
    }),
  search: z
    .object({
      max_results: z.number().int().positive().max(50).default(10),
      // num_results 的单一上限：agent 请求超过即按此截断（不报错），末尾附加说明
      max_results_cap: z.number().int().positive().max(1000).default(50),
      max_result_chars: z.number().int().positive().default(500),
      cache_ttl_ms: z.number().int().positive().default(300000),
      cache_max_entries: z.number().int().positive().default(200),
      max_concurrent: z.number().int().positive().max(16).default(2),
      engines: enginesSchema.default([]),
      fanout_default: z.number().int().min(1).max(8).default(1),
      quota_enabled: z.boolean().default(true),
      quota_ledger_path: z.string().default("~/.config/agent-search/quota.json"),
      quota_tight_threshold: z.number().min(0).max(1).default(0.1),
      resident_quota_floor: z.number().min(0).max(1).default(0.2),
      // 类别感知超时（ADR-0008）：academic 等类别的引擎更慢
      category_timeout_ms: z.record(z.string(), z.number().int().positive()).default({}),
    })
    .catch({
      max_results: 10,
      max_results_cap: 50,
      max_result_chars: 500,
      cache_ttl_ms: 300000,
      cache_max_entries: 200,
      max_concurrent: 2,
      engines: [],
      fanout_default: 1,
      quota_enabled: true,
      quota_ledger_path: "~/.config/agent-search/quota.json",
      quota_tight_threshold: 0.1,
      resident_quota_floor: 0.2,
      category_timeout_ms: {},
    }),
  rerank: z
    .object({
      enabled: z.boolean().default(true),
      engine_boost: z.record(z.string(), z.number().nonnegative()).default({}),
      diversity: z
        .object({
          enabled: z.boolean().default(false),
          mmr_lambda: z.number().min(0).max(1).default(0.7),
          max_per_domain: z.number().int().positive().default(3),
        })
        .catch({ enabled: false, mmr_lambda: 0.7, max_per_domain: 3 }),
      authority: z
        .object({
          enabled: z.boolean().default(false),
          weight: z.number().nonnegative().default(1.0),
        })
        .catch({ enabled: false, weight: 1.0 }),
    })
    .catch({
      enabled: true,
      engine_boost: {},
      diversity: { enabled: false, mmr_lambda: 0.7, max_per_domain: 3 },
      authority: { enabled: false, weight: 1.0 },
    }),
  ad_filter: z
    .object({
      enabled: z.boolean().default(true),
      level: z.enum(["off", "ads", "ads+tracking", "full"]).default("ads"),
      extra_domains: z.array(z.string()).default([]),
      hosts_file: z.string().default("data/adblock/hosts"),
      allowlist: z.array(z.string()).default([]),
      auto_update: z.boolean().default(true),
      auto_update_interval_ms: z.number().int().positive().default(86400000),
    })
    .catch({
      enabled: true,
      level: "ads",
      extra_domains: [],
      hosts_file: "data/adblock/hosts",
      allowlist: [],
      auto_update: true,
      auto_update_interval_ms: 86400000,
    }),
  fetch: z
    .object({
      timeout_ms: z.number().int().positive().default(15000),
      max_bytes: z.number().int().positive().default(5242880),
      user_agent: z.string().default(""),
      block_private_ips: z.boolean().default(true),
      private_ip_exempt_cidrs: z
        .array(z.string())
        .default(["198.18.0.0/15", "fdfe:dcba:9876::/64"]),
      structural: z.enum(["clean", "full"]).default("clean"),
      max_output_chars: z.number().int().positive().default(20000),
      cache_ttl_ms: z.number().int().positive().default(600000),
      cache_max_entries: z.number().int().positive().default(200),
      // 非文本产物（PDF/图片/二进制）落盘
      max_download_bytes: z.number().int().positive().default(1073741824),
      download_dir: z.string().default("data/downloads"),
      download_ttl_ms: z.number().int().positive().default(604800000),
      download_max_total_bytes: z.number().int().positive().default(4294967296),
      files_route: z.boolean().default(true),
    })
    .catch({
      timeout_ms: 15000,
      max_bytes: 5242880,
      user_agent: "",
      block_private_ips: true,
      private_ip_exempt_cidrs: ["198.18.0.0/15", "fdfe:dcba:9876::/64"],
      structural: "clean",
      max_output_chars: 20000,
      cache_ttl_ms: 600000,
      cache_max_entries: 200,
      max_download_bytes: 1073741824,
      download_dir: "data/downloads",
      download_ttl_ms: 604800000,
      download_max_total_bytes: 4294967296,
      files_route: true,
    }),
  browser: z
    .object({
      enabled: z.boolean().default(true),
      headless: z.boolean().default(true),
      pool_size: z.number().int().positive().max(4).default(1),
      idle_ttl_ms: z.number().int().positive().default(360000),
      timeout_ms: z.number().int().positive().default(30000),
      max_concurrent: z.number().int().positive().max(8).default(2),
      engine: z.enum(["chromium", "camoufox"]).default("chromium"),
      proxy_server: z.string().default(""),
      proxy_username: z.string().default(""),
      proxy_password: z.string().default(""),
      wait_for_selector: z.string().default(""),
      screenshot: z
        .object({
          enabled: z.boolean().default(true),
          max_size: z.number().int().positive().default(512),
          image_type: z.enum(["jpeg", "png"]).default("jpeg"),
        })
        .catch({ enabled: true, max_size: 512, image_type: "jpeg" }),
    })
    .catch({
      enabled: true,
      headless: true,
      pool_size: 1,
      idle_ttl_ms: 360000,
      timeout_ms: 30000,
      max_concurrent: 2,
      engine: "chromium",
      proxy_server: "",
      proxy_username: "",
      proxy_password: "",
      wait_for_selector: "",
      screenshot: { enabled: true, max_size: 512, image_type: "jpeg" },
    }),
  embedding: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(["openai", "ollama"]).default("openai"),
      base_url: z.string().default("http://127.0.0.1:11434/v1"),
      api_key: z.string().default(""),
      model: z.string().default(""),
      dim: z.number().int().nonnegative().default(0),
      timeout_ms: z.number().int().positive().default(5000),
      batch_size: z.number().int().positive().default(32),
      concurrency: z.number().int().positive().max(8).default(4),
      max_input_chars: z.number().int().positive().default(2000),
      query_prefix: z.string().default(""),
      passage_prefix: z.string().default(""),
    })
    .catch({
      enabled: false,
      provider: "openai",
      base_url: "http://127.0.0.1:11434/v1",
      api_key: "",
      model: "",
      dim: 0,
      timeout_ms: 5000,
      batch_size: 32,
      concurrency: 4,
      max_input_chars: 2000,
      query_prefix: "",
      passage_prefix: "",
    }),
  corpus: z
    .object({
      enabled: z.boolean().default(false),
      store_path: z.string().default("data/corpus/corpus.db"),
      ttl_ms: z.number().int().positive().default(2592000000),
      recall_k: z.number().int().positive().max(100).default(10),
      sweep_interval_ms: z.number().int().positive().default(3600000),
    })
    .catch({
      enabled: false,
      store_path: "data/corpus/corpus.db",
      ttl_ms: 2592000000,
      recall_k: 10,
      sweep_interval_ms: 3600000,
    }),
});

export type AdFilterLevel = "off" | "ads" | "ads+tracking" | "full";

export interface GatewayConfig {
  host: string;
  port: number;
  token: string | undefined;
  logLevel: "debug" | "info" | "warn" | "error";
  logFile: string | undefined;
  searxngUrl: string;
  searxngTimeoutMs: number;
  flaresolverrUrl: string;
  flaresolverrEnabled: boolean;
  flaresolverrTimeoutMs: number;
  flaresolverrMaxConcurrent: number;
  flaresolverrTriggerStatus: number[];
  flaresolverrFallbackOnEmpty: boolean;
  searchMaxResults: number;
  /**
   * `num_results` 的单一上限：agent 请求超过即按此截断（不报错），
   * 并在结果末尾附加说明。见 search.max_results_cap。
   */
  searchMaxResultsCap: number;
  searchMaxResultChars: number;
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;
  searchMaxConcurrent: number;
  /** 轮换档（旧平铺数组格式时即该数组本身）。 */
  searchEngines: string[];
  /** 常住档：每次查询都叠加，额度接近耗尽才移出（默认空 = 旧行为）。 */
  searchEnginesResident: string[];
  searchFanoutDefault: number;
  searchQuotaEnabled: boolean;
  searchQuotaLedgerPath: string;
  searchQuotaTightThreshold: number;
  searchResidentQuotaFloor: number;
  /**
   * 类别感知超时（search.category_timeout_ms，如 `{ academic: 25000 }`）。
   * 命中请求类别时覆盖 searxngTimeoutMs；未命中回落 searxngTimeoutMs。
   */
  searchCategoryTimeoutMs: Record<string, number>;
  rerankEnabled: boolean;
  rerankEngineBoost: Record<string, number>;
  /** 多样性重排（MMR + 同注册域上限）；关闭时行为等同纯 cosine 重排。 */
  rerankDiversityEnabled: boolean;
  /** MMR λ：0=全多样，1=全相关。 */
  rerankDiversityMmrLambda: number;
  /** 同一注册域（eTLD+1）最多入选项数。 */
  rerankDiversityMaxPerDomain: number;
  /** 权威信号（相关分上叠加 w·auth）；关闭时行为等同纯 cosine 重排。 */
  rerankAuthorityEnabled: boolean;
  /** 权威分权重；最终分 = rel_norm + weight·auth。 */
  rerankAuthorityWeight: number;
  adFilterEnabled: boolean;
  adFilterLevel: AdFilterLevel;
  adFilterExtraDomains: string[];
  adFilterHostsFile: string;
  adFilterAllowlist: string[];
  adFilterAutoUpdate: boolean;
  adFilterAutoUpdateIntervalMs: number;
  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  fetchUserAgent: string;
  fetchBlockPrivateIps: boolean;
  fetchPrivateIpExemptCidrs: string[];
  fetchStructural: "clean" | "full";
  fetchMaxOutputChars: number;
  fetchCacheTtlMs: number;
  fetchCacheMaxEntries: number;
  /** 非文本产物单文件上限（max_download_bytes，默认 1GB）；有 Content-Length 时在下载前预检。 */
  fetchMaxDownloadBytes: number;
  /** 产物落盘目录（相对路径相对进程工作目录）。 */
  fetchDownloadDir: string;
  /** 产物 TTL（download_ttl_ms）。 */
  fetchDownloadTtlMs: number;
  /** 产物总量配额（download_max_total_bytes）。 */
  fetchDownloadMaxTotalBytes: number;
  /** 是否提供 GET /files/<id>。 */
  fetchFilesRoute: boolean;
  browserEnabled: boolean;
  browserHeadless: boolean;
  browserPoolSize: number;
  browserIdleTtlMs: number;
  browserTimeoutMs: number;
  browserMaxConcurrent: number;
  browserEngine: "chromium" | "camoufox";
  browserProxyServer: string;
  browserProxyUsername: string;
  browserProxyPassword: string;
  browserWaitForSelector: string;
  browserScreenshotEnabled: boolean;
  browserScreenshotMaxSize: number;
  browserScreenshotImageType: "jpeg" | "png";
  embeddingEnabled: boolean;
  embeddingProvider: "openai" | "ollama";
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingDim: number;
  embeddingTimeoutMs: number;
  embeddingBatchSize: number;
  embeddingConcurrency: number;
  embeddingMaxInputChars: number;
  embeddingQueryPrefix: string;
  embeddingPassagePrefix: string;
  corpusEnabled: boolean;
  corpusStorePath: string;
  corpusTtlMs: number;
  corpusRecallK: number;
  corpusSweepIntervalMs: number;
}

export function defaultConfigPath(): string {
  return resolve(process.cwd(), "gateway.yaml");
}

/**
 * 加载 gateway.yaml，用 zod 校验，返回强类型配置。
 * token 优先用环境变量 GATEWAY_TOKEN 覆盖（避免密钥写文件）。
 * 找不到 yaml 或校验失败时抛错。
 */
export function loadConfig(configPath: string = defaultConfigPath()): GatewayConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `配置文件不存在: ${configPath}。请复制 gateway.yaml.example 为 gateway.yaml 后修改。`,
    );
  }

  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(`gateway.yaml 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`gateway.yaml 内容为空或格式非法`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`gateway.yaml 校验失败: ${issues}`);
  }

  const v = parsed.data;
  const envToken = process.env.GATEWAY_TOKEN;
  const token = envToken && envToken.length > 0 ? envToken : v.gateway.token;

  // 引擎清单兼容解析：平铺数组 → 全轮换；对象 → 分档。
  const engines = v.search.engines;
  const resident = Array.isArray(engines) ? [] : engines.resident;
  const rotating = Array.isArray(engines) ? engines : engines.rotating;

  return {
    host: v.gateway.host,
    port: v.gateway.port,
    token: token && token.length > 0 ? token : undefined,
    logLevel: v.logging.level,
    logFile: v.logging.file && v.logging.file.length > 0 ? v.logging.file : undefined,
    searxngUrl: v.searxng.url.replace(/\/+$/, ""),
    searxngTimeoutMs: v.searxng.timeout_ms,
    flaresolverrUrl: v.flaresolverr.url.replace(/\/+$/, ""),
    flaresolverrEnabled: v.flaresolverr.enabled,
    flaresolverrTimeoutMs: v.flaresolverr.timeout_ms,
    flaresolverrMaxConcurrent: v.flaresolverr.max_concurrent,
    flaresolverrTriggerStatus: v.flaresolverr.trigger_status,
    flaresolverrFallbackOnEmpty: v.flaresolverr.fallback_on_empty,
    searchMaxResults: v.search.max_results,
    searchMaxResultsCap: v.search.max_results_cap,
    searchMaxResultChars: v.search.max_result_chars,
    searchCacheTtlMs: v.search.cache_ttl_ms,
    searchCacheMaxEntries: v.search.cache_max_entries,
    searchMaxConcurrent: v.search.max_concurrent,
    searchEngines: rotating,
    searchEnginesResident: resident,
    searchFanoutDefault: v.search.fanout_default,
    searchQuotaEnabled: v.search.quota_enabled,
    searchQuotaLedgerPath: expandHome(v.search.quota_ledger_path),
    searchQuotaTightThreshold: v.search.quota_tight_threshold,
    searchResidentQuotaFloor: v.search.resident_quota_floor,
    searchCategoryTimeoutMs: v.search.category_timeout_ms,
    rerankEnabled: v.rerank.enabled,
    rerankEngineBoost: v.rerank.engine_boost,
    rerankDiversityEnabled: v.rerank.diversity.enabled,
    rerankDiversityMmrLambda: v.rerank.diversity.mmr_lambda,
    rerankDiversityMaxPerDomain: v.rerank.diversity.max_per_domain,
    rerankAuthorityEnabled: v.rerank.authority.enabled,
    rerankAuthorityWeight: v.rerank.authority.weight,
    adFilterEnabled: v.ad_filter.enabled,
    adFilterLevel: v.ad_filter.level,
    adFilterExtraDomains: v.ad_filter.extra_domains,
    adFilterHostsFile: v.ad_filter.hosts_file,
    adFilterAllowlist: v.ad_filter.allowlist,
    adFilterAutoUpdate: v.ad_filter.auto_update,
    adFilterAutoUpdateIntervalMs: v.ad_filter.auto_update_interval_ms,
    fetchTimeoutMs: v.fetch.timeout_ms,
    fetchMaxBytes: v.fetch.max_bytes,
    fetchUserAgent: v.fetch.user_agent,
    fetchBlockPrivateIps: v.fetch.block_private_ips,
    fetchPrivateIpExemptCidrs: v.fetch.private_ip_exempt_cidrs,
    fetchStructural: v.fetch.structural,
    fetchMaxOutputChars: v.fetch.max_output_chars,
    fetchCacheTtlMs: v.fetch.cache_ttl_ms,
    fetchCacheMaxEntries: v.fetch.cache_max_entries,
    fetchMaxDownloadBytes: v.fetch.max_download_bytes,
    fetchDownloadDir: v.fetch.download_dir,
    fetchDownloadTtlMs: v.fetch.download_ttl_ms,
    fetchDownloadMaxTotalBytes: v.fetch.download_max_total_bytes,
    fetchFilesRoute: v.fetch.files_route,
    browserEnabled: v.browser.enabled,
    browserHeadless: v.browser.headless,
    browserPoolSize: v.browser.pool_size,
    browserIdleTtlMs: v.browser.idle_ttl_ms,
    browserTimeoutMs: v.browser.timeout_ms,
    browserMaxConcurrent: v.browser.max_concurrent,
    browserEngine: v.browser.engine,
    browserProxyServer: v.browser.proxy_server,
    browserProxyUsername: v.browser.proxy_username,
    browserProxyPassword: v.browser.proxy_password,
    browserWaitForSelector: v.browser.wait_for_selector,
    browserScreenshotEnabled: v.browser.screenshot.enabled,
    browserScreenshotMaxSize: v.browser.screenshot.max_size,
    browserScreenshotImageType: v.browser.screenshot.image_type,
    embeddingEnabled: v.embedding.enabled,
    embeddingProvider: v.embedding.provider,
    embeddingBaseUrl: v.embedding.base_url.replace(/\/+$/, ""),
    embeddingApiKey: process.env.EMBEDDING_API_KEY || v.embedding.api_key,
    embeddingModel: v.embedding.model,
    embeddingDim: v.embedding.dim,
    embeddingTimeoutMs: v.embedding.timeout_ms,
    embeddingBatchSize: v.embedding.batch_size,
    embeddingConcurrency: v.embedding.concurrency,
    embeddingMaxInputChars: v.embedding.max_input_chars,
    embeddingQueryPrefix: v.embedding.query_prefix,
    embeddingPassagePrefix: v.embedding.passage_prefix,
    corpusEnabled: v.corpus.enabled,
    corpusStorePath: v.corpus.store_path,
    corpusTtlMs: v.corpus.ttl_ms,
    corpusRecallK: v.corpus.recall_k,
    corpusSweepIntervalMs: v.corpus.sweep_interval_ms,
  };
}
