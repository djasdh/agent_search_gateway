import { z } from "zod";
import { GATEWAY_SOURCES } from "./gateway-sources.js";

/**
 * 设置 schema（唯一默认值来源）。
 *
 * 约定：字段名与 gateway.yaml **完全一致**（snake_case、嵌套结构），
 * 不再做「YAML → 扁平前缀字段」的映射。组件拿到的就是对应子树。
 *
 * 所有对象一律 strict：拼错字段、残留旧字段都会直接报错，
 * 避免配置被静默忽略（尤其是 token/api_key 这类安全相关项）。
 */

const enginesSchema = z
  .object({
    resident: z.array(z.string()).default([]),
    rotating: z.array(z.string()).default([]),
  })
  .strict();

export const gatewaySchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().max(65535).default(3000),
  })
  .strict();

export const loggingSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    file: z.string().default(""),
  })
  .strict();

export const searxngSchema = z
  .object({
    url: z.string().url().default("http://127.0.0.1:8888"),
    timeout_ms: z.number().int().positive().default(10000),
  })
  .strict();

export const flaresolverrSchema = z
  .object({
    url: z.string().url().default("http://127.0.0.1:8192"),
    enabled: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(60000),
    max_concurrent: z.number().int().positive().max(16).default(2),
    trigger_status: z.array(z.number().int().positive()).default([403, 405, 429]),
    fallback_on_empty: z.boolean().default(true),
  })
  .strict();

const publishSchema = z
  .object({
    enabled: z.boolean().default(true),
    endpoint: z.string().url().default("https://uguu.se/upload?output=json"),
    timeout_ms: z.number().int().positive().default(20000),
  })
  .strict();

const saucenaoSchema = z
  .object({
    url: z.string().url().default("https://saucenao.com"),
    timeout_ms: z.number().int().positive().default(15000),
    max_results: z.number().int().positive().max(20).default(8),
    minsim: z.number().min(0).max(100).default(30),
  })
  .strict();

const baiduReverseSchema = z
  .object({
    enabled: z.boolean().default(true),
    url: z.string().url().default("https://graph.baidu.com"),
    timeout_ms: z.number().int().positive().default(15000),
    max_results: z.number().int().positive().max(30).default(8),
  })
  .strict();

const reverseImageSchema = z
  .object({
    enabled: z.boolean().default(true),
    category: z.string().default("search_by_image"),
    sources: z.array(z.enum(GATEWAY_SOURCES)).default([...GATEWAY_SOURCES]),
    tracemoe_url: z.string().url().default("https://api.trace.moe"),
    tracemoe_timeout_ms: z.number().int().positive().default(15000),
    tracemoe_max_results: z.number().int().positive().max(20).default(8),
    /** 本地图片（image_path）读取上限；multipart 直传与图床发布共用。 */
    local_max_bytes: z.number().int().positive().default(5242880),
    publish: publishSchema.default(() => publishSchema.parse({})),
    saucenao: saucenaoSchema.default(() => saucenaoSchema.parse({})),
    baidu: baiduReverseSchema.default(() => baiduReverseSchema.parse({})),
  })
  .strict();

const searchDeepseekApiSchema = z
  .object({
    base_url: z.string().url().default("https://api.deepseek.com/v1/tools"),
    need_content: z.boolean().default(false),
    localization: z.string().default(""),
    timeout_ms: z.number().int().positive().default(20000),
  })
  .strict();

const searchDeepseekHarnessSchema = z
  .object({
    base_url: z.string().url().default("https://api.deepseek.com/anthropic/v1"),
    model: z.string().min(1).default("deepseek-flash"),
    max_tokens: z.number().int().positive().default(4096),
    api_version: z.string().min(1).default("2023-06-01"),
    timeout_ms: z.number().int().positive().default(60000),
  })
  .strict();

/**
 * DeepSeek 通用上游（默认关闭）。
 *
 * - raw：调用 Search API，官方分只用于源内排序 / min_score；
 * - harness：Messages + `deepseek_web_search`，无原始分。
 */
const searchDeepseekSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["raw", "harness"]).default("raw"),
    limit: z.number().int().positive().max(50).default(10),
    api: searchDeepseekApiSchema.default(() => searchDeepseekApiSchema.parse({})),
    harness: searchDeepseekHarnessSchema.default(() => searchDeepseekHarnessSchema.parse({})),
  })
  .strict();

export const searchSchema = z
  .object({
    max_results: z.number().int().positive().max(50).default(10),
    // num_results 的单一上限：agent 请求超过即按此截断（不报错），末尾附加说明
    max_results_cap: z.number().int().positive().max(1000).default(50),
    max_result_chars: z.number().int().positive().default(500),
    cache_ttl_ms: z.number().int().positive().default(300000),
    cache_max_entries: z.number().int().positive().default(200),
    max_concurrent: z.number().int().positive().max(16).default(2),
    engines: enginesSchema.default(() => enginesSchema.parse({})),
    fanout_default: z.number().int().min(1).max(8).default(1),
    quota_enabled: z.boolean().default(true),
    quota_ledger_path: z.string().default("~/.config/agent-search/quota.json"),
    quota_tight_threshold: z.number().min(0).max(1).default(0.1),
    resident_quota_floor: z.number().min(0).max(1).default(0.2),
    // 类别感知超时（ADR-0008 / ADR-0013）：science 等类别的引擎更慢
    category_timeout_ms: z.record(z.string(), z.number().int().positive()).default({}),
    reverse_image: reverseImageSchema.default(() => reverseImageSchema.parse({})),
    deepseek: searchDeepseekSchema.default(() => searchDeepseekSchema.parse({})),
  })
  .strict();

const diversitySchema = z
  .object({
    enabled: z.boolean().default(false),
    mmr_lambda: z.number().min(0).max(1).default(0.7),
    max_per_domain: z.number().int().positive().default(3),
  })
  .strict();

const authoritySchema = z
  .object({
    enabled: z.boolean().default(false),
    weight: z.number().nonnegative().default(1.0),
  })
  .strict();

export const rerankSchema = z
  .object({
    enabled: z.boolean().default(true),
    engine_boost: z.record(z.string(), z.number().nonnegative()).default({}),
    diversity: diversitySchema.default(() => diversitySchema.parse({})),
    authority: authoritySchema.default(() => authoritySchema.parse({})),
  })
  .strict();

export const adFilterSchema = z
  .object({
    enabled: z.boolean().default(true),
    level: z.enum(["off", "ads", "ads+tracking", "full"]).default("ads"),
    extra_domains: z.array(z.string()).default([]),
    hosts_file: z.string().default("data/adblock/hosts"),
    allowlist: z.array(z.string()).default([]),
    auto_update: z.boolean().default(true),
    auto_update_interval_ms: z.number().int().positive().default(86400000),
  })
  .strict();

export const fetchSchema = z
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
    // 非文本产物（PDF/图片/二进制）落盘：见 README 与 gateway.yaml.example
    max_download_bytes: z.number().int().positive().default(1073741824),
    download_dir: z.string().default("data/downloads"),
    download_ttl_ms: z.number().int().positive().default(604800000),
    download_max_total_bytes: z.number().int().positive().default(4294967296),
    files_route: z.boolean().default(true),
  })
  .strict();

const screenshotSchema = z
  .object({
    enabled: z.boolean().default(true),
    max_size: z.number().int().positive().default(512),
    image_type: z.enum(["jpeg", "png"]).default("jpeg"),
  })
  .strict();

export const browserSchema = z
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
    wait_for_selector: z.string().default(""),
    screenshot: screenshotSchema.default(() => screenshotSchema.parse({})),
  })
  .strict();

export const embeddingSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["openai", "ollama"]).default("openai"),
    base_url: z.string().default("http://127.0.0.1:11434/v1"),
    model: z.string().default(""),
    dim: z.number().int().nonnegative().default(0),
    timeout_ms: z.number().int().positive().default(5000),
    batch_size: z.number().int().positive().default(32),
    concurrency: z.number().int().positive().max(8).default(4),
    max_input_chars: z.number().int().positive().default(2000),
    query_prefix: z.string().default(""),
    passage_prefix: z.string().default(""),
  })
  .strict();

export const corpusSchema = z
  .object({
    enabled: z.boolean().default(false),
    store_path: z.string().default("data/corpus/corpus.db"),
    ttl_ms: z.number().int().positive().default(2592000000),
    recall_k: z.number().int().positive().max(100).default(10),
    sweep_interval_ms: z.number().int().positive().default(3600000),
  })
  .strict();

/**
 * 第三方扩展的网关配置（按完整 engineId 索引）。
 *
 * 承载路由覆盖与插件私有配置：插件自身有默认类别，用户在这里按引擎改写；
 * config 段由插件 manifest 的 config_schema 校验，网关这里只要求它是对象。
 */
const extensionRoutingSchema = z
  .object({
    category: z.string().optional(),
    hot_category: z.string().optional(),
  })
  .strict();

const extensionSchema = z
  .object({
    routing: extensionRoutingSchema.default(() => extensionRoutingSchema.parse({})),
    config: z.record(z.string(), z.unknown()).default(() => ({})),
  })
  .strict();

export const extensionsSchema = z.record(z.string(), extensionSchema).default({});

export const settingsSchema = z
  .object({
    gateway: gatewaySchema.default(() => gatewaySchema.parse({})),
    logging: loggingSchema.default(() => loggingSchema.parse({})),
    searxng: searxngSchema.default(() => searxngSchema.parse({})),
    flaresolverr: flaresolverrSchema.default(() => flaresolverrSchema.parse({})),
    search: searchSchema.default(() => searchSchema.parse({})),
    rerank: rerankSchema.default(() => rerankSchema.parse({})),
    ad_filter: adFilterSchema.default(() => adFilterSchema.parse({})),
    fetch: fetchSchema.default(() => fetchSchema.parse({})),
    browser: browserSchema.default(() => browserSchema.parse({})),
    embedding: embeddingSchema.default(() => embeddingSchema.parse({})),
    corpus: corpusSchema.default(() => corpusSchema.parse({})),
    extensions: extensionsSchema,
  })
  .strict();
