import type { GatewayConfig } from "../config.js";
import type { DomainFilter } from "../filter/domain-filter.js";
import { isBlocked } from "../filter/domain-filter.js";
import { readFileSync } from "node:fs";
import type { Logger } from "../logger.js";
import { ErrorCodes, withCode } from "../utils/errors.js";
import { Semaphore } from "../utils/semaphore.js";
import { StringCache } from "./cache.js";
import { cleanResults, resultEngines, type CleanedResult } from "./clean.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import { mmrSelect, registeredDomainOfUrl } from "./embedding/diversity.js";
import { mergeAndRank, type SemanticTimings } from "./embedding/semantic.js";
import type { CorpusStore } from "./embedding/store.js";
import type { EmbedResult } from "./embedding/types.js";
import { loadLocalImage, publishImage, type LocalImage, type PublishResult } from "./image-publish.js";
import { renderResults, renderSearchMarkdown } from "./render.js";
import { rerankResults } from "./rerank.js";
import {
  extractImageUrl,
  searchTraceMoe,
  searchTraceMoeUpload,
  unionResults,
  type TraceMoeCall,
} from "./reverse-image.js";
import {
  searchSearxng,
  type SearchCallError,
  type SearchRequest,
  type SearxngResult,
  type SearxngResponse,
} from "./searxng.js";

export interface SearchParams {
  query: string;
  language?: string;
  safeSearch?: string;
  categories?: string;
  engines?: string;
  fanout?: number;
  minScore?: number;
  numResults?: number;
  /** 反向图搜（ADR-0011）：本地图片路径；与 query 里的图片 URL 互斥。 */
  imagePath?: string;
}

export interface SearchOutcome {
  ok: boolean;
  code?: (typeof ErrorCodes)[keyof typeof ErrorCodes];
  text: string;
  cacheHit?: boolean;
}

export interface SearchService {
  search(params: SearchParams): Promise<SearchOutcome>;
}

/** 配额台账里的单引擎条目（由 searxng 的 quota 插件写入）。 */
export interface QuotaEntry {
  type: "daily" | "monthly" | "once";
  window: string;
  limit: number;
  used: number;
}

/** 引擎名 → 台账条目。 */
export type QuotaLedger = Record<string, QuotaEntry>;

/** searxng /config 的 enabled 引擎集合缓存时长。 */
const ENABLED_ENGINES_TTL_MS = 60_000;

/** 配额台账读取缓存时长；较短以便快速感知插件侧的计数变化。 */
const QUOTA_LEDGER_TTL_MS = 10_000;

/** 解析逗号分隔的引擎列表。 */
function parseEngineList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 校验并规整台账 JSON；结构非法时返回 undefined（调用方优雅降级）。 */
export function parseQuotaLedger(raw: unknown): QuotaLedger | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const engines = (raw as { engines?: unknown }).engines;
  if (!engines || typeof engines !== "object") return undefined;
  const out: QuotaLedger = {};
  for (const [name, value] of Object.entries(engines as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    if (e.type !== "daily" && e.type !== "monthly" && e.type !== "once") continue;
    const limit = Number(e.limit);
    const used = Number(e.used);
    if (!Number.isFinite(limit) || !Number.isFinite(used)) continue;
    out[name] = { type: e.type, window: typeof e.window === "string" ? e.window : "", limit, used };
  }
  return out;
}

/** 剩余额度占比（无台账/额度非正 → 视为 1，即不受配额约束）。 */
function remainingRatio(entry: QuotaEntry | undefined): number {
  if (!entry || entry.limit <= 0) return 1;
  return Math.max(0, (entry.limit - entry.used) / entry.limit);
}

/** 台账判定引擎是否已耗尽。 */
function isExhausted(entry: QuotaEntry | undefined): boolean {
  return !!entry && entry.limit > 0 && entry.used >= entry.limit;
}

/** 候选引擎的整体剩余占比是否低于阈值（余额紧张）。 */
function isQuotaTight(usable: string[], quota: QuotaLedger, threshold: number): boolean {
  let totalLimit = 0;
  let totalRemaining = 0;
  for (const name of usable) {
    const q = quota[name];
    if (!q || q.limit <= 0) continue;
    totalLimit += q.limit;
    totalRemaining += Math.max(0, q.limit - q.used);
  }
  if (totalLimit === 0) return false;
  return totalRemaining / totalLimit < threshold;
}

/**
 * 一个引擎批次：`engines` 是发给 searxng 的完整点名（resident ∪ rotating），
 * `rotating` 是本批实际参与的 rotating 候选——用于「按 rotating 子集判定是否
 * 成功」（resident 恒有结果，不能作为成功依据）。`rotating` 为空表示该批没有
 * rotating 候选（显式 engines / 纯 resident / 未配置），此时回退旧语义：非空即止。
 */
export interface EngineBatch {
  engines: string;
  rotating: string[];
}

/**
 * 计算本次搜索的引擎批次（静默降级的候选序列）：
 * - `engines` 显式指定 → 严格按该集合，一次查完（仍按台账剔除已耗尽者）
 * - 否则按「分档」组合：
 *   - **resident**（`config.searchEnginesResident`）：未被 disabled、且额度未接近
 *     耗尽（剩余 < `resident_quota_floor`）的引擎，**每一批都带上**；无台账=永不降
 *   - **rotating**（`config.searchEngines`）：取前 `fanout` 家轮换，批次无结果/不可用时换下一批
 * - resident 为空 → 与旧行为（纯 rotating）逐字等价
 * - 跳过 searxng 侧 `enabled:false` 的引擎（如 youcom），使其不占用批次
 * - 有台账时:剔除已耗尽引擎；`fanout>1` 按剩余额度降序取前 N；
 *   整体余额低于 `quota_tight_threshold` 时把扇出压回 1
 * - **类别抑制**（ADR-0008）：请求类别含 `general` 以外的类别 → 抑制 resident ∪
 *   rotating，`engines` 留空交 searxng 按类别选引擎；显式 `engines` 不受影响
 */

/** 请求类别是否含 `general` 以外的类别（ADR-0008）。 */
export function hasNonGeneralCategory(categories: string | undefined): boolean {
  return (categories ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .some((c) => c !== "general");
}

/** 请求是否只要图片（显式 `images` 类别；非 general 类别即「只要这一类」，ADR-0008）。 */
export function isImageQuery(categories: string | undefined, extra: string[] = []): boolean {
  const want = new Set(["images", ...extra.map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0)]);
  return (categories ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .some((c) => want.has(c));
}

/**
 * 反向图搜触发判定（ADR-0010）：请求类别里出现配置的类别名（大小写不敏感）。
 * 「图就是 query」——类别只是开关，图片本身是以 URL 形式写在 query 里。
 */
export function isReverseImageQuery(categories: string | undefined, canonical: string): boolean {
  const want = (canonical ?? "").trim().toLowerCase();
  if (!want) return false;
  return (categories ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .some((c) => c === want);
}

/**
 * 把请求类别里的配置类别名（大小写变体）归一成规范名后转发。
 *
 * searxng 按**字面**匹配类别（`categ in categories`），声明与请求必须同字串；
 * 这里只在该类别确实出现时改写，未命中的请求逐字不动（保证既有行为零变化）。
 */
export function canonicalizeCategories(categories: string | undefined, canonical: string): string | undefined {
  if (!categories || !canonical) return categories;
  const want = canonical.toLowerCase();
  const parts = categories.split(",").map((c) => c.trim());
  if (!parts.some((c) => c.toLowerCase() === want)) return categories;
  return parts
    .filter((c) => c.length > 0)
    .map((c) => (c.toLowerCase() === want ? canonical : c))
    .join(",");
}

/**
 * 图片查询的排序：不 embedding、不召回语料。
 *
 * 图片结果没有正文（embedding 只能拿标题，收益低），而语料是**文本**库——把图片
 * 来源页写进语料会污染后续文本召回，反向召回文本条目又只会成为图片查询的噪声。
 * 因此直接沿用 rerank 的 `score × boost` 顺序；多样性开启时只保留同注册域上限
 * （λ=1 时 MMR 项失效，行为等于「按分排序 + 同域上限」）。
 */
export function selectImageResults(
  results: CleanedResult[],
  limit: number,
  diversity: { enabled: boolean; mmrLambda: number; maxPerDomain: number },
): CleanedResult[] {
  if (!diversity.enabled) return results.slice(0, limit);
  return mmrSelect(
    results.map((item) => ({ score: item.score ?? 0, item })),
    limit,
    { mmrLambda: diversity.mmrLambda, maxPerDomain: diversity.maxPerDomain },
    (c) => registeredDomainOfUrl(c.item.url),
  ).map((c) => c.item);
}

/**
 * 类别感知的 searxng 超时（D18）：按请求类别顺序取第一个命中
 * `search.category_timeout_ms` 的值；未命中 → `searxngTimeoutMs`。
 */
export function resolveSearxngTimeout(params: SearchParams, config: GatewayConfig): number {
  const cats = (params.categories ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  for (const c of cats) {
    const t = config.searchCategoryTimeoutMs?.[c];
    if (t !== undefined) return t;
  }
  return config.searxngTimeoutMs;
}

export function planEngineBatches(
  params: SearchParams,
  config: GatewayConfig,
  enabled: Set<string> | undefined,
  quota: QuotaLedger | undefined,
): EngineBatch[] {
  const explicit = parseEngineList(params.engines);
  if (explicit.length > 0) {
    const usable = quota ? explicit.filter((e) => !isExhausted(quota[e])) : explicit;
    // 显式 engines：单批、无 rotating 子集概念 → 非空即止（旧行为）
    return [{ engines: (usable.length > 0 ? usable : explicit).join(","), rotating: [] }];
  }

  // ADR-0008：指定了非 general 类别 → 抑制常驻源与轮换源（engines 留空，
  // 交 searxng 按类别选引擎）。显式 engines 已在上面优先返回，不受此影响。
  if (hasNonGeneralCategory(params.categories)) {
    return [{ engines: "", rotating: [] }];
  }

  const resident = config.searchEnginesResident ?? [];
  const rotating = config.searchEngines ?? [];
  if (resident.length === 0 && rotating.length === 0) return [{ engines: "", rotating: [] }]; // 交给 searxng 默认

  // 常住档：未被 disabled、且额度未接近耗尽 → 每次查询都带上
  const floor = config.searchResidentQuotaFloor ?? 0.2;
  const residentUsable = (enabled ? resident.filter((e) => enabled.has(e)) : resident.slice()).filter((e) => {
    const q = quota?.[e];
    return !isExhausted(q) && remainingRatio(q) >= floor;
  });

  // 轮换档：沿用既有台账逻辑（剔除耗尽 / fanout / 紧张压回）
  const filtered = enabled ? rotating.filter((e) => enabled.has(e)) : rotating.slice();
  let usable = filtered.length > 0 ? filtered : rotating.slice();

  if (quota) usable = usable.filter((e) => !isExhausted(quota[e]));

  let fanout = Math.max(1, params.fanout ?? config.searchFanoutDefault ?? 1);

  // 余额紧张 → 把扇出压回 1（§9）
  if (quota && fanout > 1 && isQuotaTight(usable, quota, config.searchQuotaTightThreshold)) {
    fanout = 1;
  }

  // fanout>1 时按剩余额度降序取前 N（稳定的，同额度保持优先级顺序）
  if (quota && fanout > 1) {
    usable = usable
      .map((name, idx) => ({ name, idx }))
      .sort((a, b) => {
        const diff = remainingRatio(quota[b.name]) - remainingRatio(quota[a.name]);
        return diff !== 0 ? diff : a.idx - b.idx;
      })
      .map((x) => x.name);
  }

  const rotatingBatches: string[][] = [];
  for (let i = 0; i < usable.length; i += fanout) {
    rotatingBatches.push(usable.slice(i, i + fanout));
  }

  // resident 为空 → 保持旧行为（仅轮换）；每批的 rotating 子集就是整批
  if (residentUsable.length === 0) {
    return rotatingBatches.map((batch) => ({ engines: batch.join(","), rotating: batch }));
  }

  const residentPrefix = residentUsable.join(",");
  if (rotatingBatches.length === 0) return [{ engines: residentPrefix, rotating: [] }];
  return rotatingBatches.map((batch) => ({
    engines: `${residentPrefix},${batch.join(",")}`,
    rotating: batch,
  }));
}

/** 引擎批次中「发给 searxng 的完整点名」序列（planEngineBatches 的兼容视图）。 */
export function planEngines(
  params: SearchParams,
  config: GatewayConfig,
  enabled: Set<string> | undefined,
  quota: QuotaLedger | undefined,
): string[] {
  return planEngineBatches(params, config, enabled, quota).map((b) => b.engines);
}

/**
 * 本批结果里是否有 rotating 候选贡献（用结果的 `engine` 字段判定）。
 * rotating 为空 → 视为贡献（该批没有 rotating 候选，回退旧语义）。
 */
export function rotatingContributed(results: SearxngResult[], rotating: string[]): boolean {
  if (rotating.length === 0) return true;
  const want = new Set(rotating);
  return results.some((r) => resultEngines(r).some((e) => want.has(e)));
}

/** 语义层可选依赖；缺省即关闭（行为与旧版一致）。 */
export interface SearchDeps {
  embeddingProvider?: EmbeddingProvider | null;
  corpus?: CorpusStore | null;
  recallK?: number;
  /** 结构化耗时打点回调；缺省时仅落一条 debug 日志。 */
  metricsSink?: (metrics: SearchMetrics) => void;
}

/**
 * 单次搜索的分阶段耗时（ms），供瓶颈定位。
 * 单位均 ms；`residualMs` = total − 其余显式阶段之和（缓存写回/JSON 序列化等）。
 */
export interface SearchMetrics {
  query: string;
  cacheHit: boolean;
  /** 端到端墙钟（含引擎/配额加载、缓存查、信号量等待）。 */
  totalMs: number;
  /** 引擎集合/配额台账加载 + 缓存查 + 信号量等待。 */
  preMs: number;
  /** searxng 请求墙钟（跨批次累加）。 */
  upstreamMs: number;
  /** 实际发出的上游批次数。 */
  upstreamBatches: number;
  /** 最终采用批次的候选数。 */
  upstreamRaw: number;
  /** 按结果 engine 字段统计的引擎分布（可选信息）。 */
  engineCounts: Record<string, number>;
  /** 本地轻量重排（score×boost）+ 过滤清洗。 */
  localMs: number;
  /** mergeAndRank 整体墙钟（≈ 语义层 totalMs）。 */
  mergeMs: number;
  /** markdown 渲染。 */
  renderMs: number;
  /** total − 以上阶段之和。 */
  residualMs: number;
  /** 语义层内部分解（query/passage 向量、corpus、排序、MMR）；降级/未启用为 null。 */
  semantic: SemanticTimings | null;
  /** 语义层是否降级（embedding/语料不可用或失败）。 */
  degraded: boolean;
  /** 反向图搜（ADR-0010/0011）：网关侧附加源的调用结果；未触发为 undefined。 */
  reverseImage?: {
    source: string;
    ok: boolean;
    results: number;
    ms: number;
    error?: string;
    /** 本地图是否成功发布到公网图床（非本地图请求为 undefined） */
    published?: boolean;
    publishMs?: number;
  };
}

/** 构造稳定缓存键（搜索参数 + 选中引擎批次 + 语料命名空间一致）。 */
function cacheKey(params: SearchParams, batches: string[], semanticTag = ""): string {
  return JSON.stringify([
    params.query,
    params.language ?? "",
    params.safeSearch ?? "",
    params.categories ?? "",
    params.engines ?? "",
    params.fanout ?? "",
    batches,
    params.minScore ?? "",
    params.numResults ?? "",
    semanticTag,
  ]);
}

/**
 * 加载 searxng 已启用的引擎集合（`GET /config`）。
 * 失败时返回 undefined（调用方退化为「不剔除」），并做短期负缓存避免反复打网络。
 */
function createEnabledEnginesLoader(config: GatewayConfig, logger: Logger) {
  let cached: { at: number; set: Set<string> | undefined } | undefined;
  return async (): Promise<Set<string> | undefined> => {
    const now = Date.now();
    if (cached && now - cached.at < ENABLED_ENGINES_TTL_MS) return cached.set;
    try {
      const res = await fetch(`${config.searxngUrl}/config`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { engines?: Array<{ name?: string; enabled?: boolean }> };
      const set = new Set<string>();
      for (const e of data.engines ?? []) {
        if (e.name && e.enabled) set.add(e.name);
      }
      cached = { at: now, set };
      return set;
    } catch (err) {
      logger.debug(`enabled engines fetch failed: ${String(err)}`);
      cached = { at: now, set: undefined };
      return undefined;
    }
  };
}

/**
 * 加载 searxng 插件写入的配额台账（JSON 文件）。
 * 未启用/路径为空/文件不可读/结构非法 → 返回 undefined（调用方退化为现状），
 * 并做短期负缓存避免每请求都打文件系统。
 */
function createQuotaLoader(config: GatewayConfig, logger: Logger) {
  let cached: { at: number; ledger: QuotaLedger | undefined } | undefined;
  return async (): Promise<QuotaLedger | undefined> => {
    if (!config.searchQuotaEnabled || !config.searchQuotaLedgerPath) return undefined;
    const now = Date.now();
    if (cached && now - cached.at < QUOTA_LEDGER_TTL_MS) return cached.ledger;
    try {
      const raw = JSON.parse(readFileSync(config.searchQuotaLedgerPath, "utf-8"));
      const ledger = parseQuotaLedger(raw);
      cached = { at: now, ledger };
      return ledger;
    } catch (err) {
      logger.debug(`quota ledger read failed: ${String(err)}`);
      cached = { at: now, ledger: undefined };
      return undefined;
    }
  };
}

export function createSearchService(
  config: GatewayConfig,
  domainFilter: DomainFilter,
  logger: Logger,
  deps: SearchDeps = {},
): SearchService {
  const cache = new StringCache(config.searchCacheMaxEntries, config.searchCacheTtlMs);
  const sem = new Semaphore(config.searchMaxConcurrent);
  const getEnabledEngines = createEnabledEnginesLoader(config, logger);
  const getQuota = createQuotaLoader(config, logger);
  const provider = deps.embeddingProvider ?? null;
  const corpus = deps.corpus ?? null;
  const recallK = deps.recallK ?? 10;
  const diversity = {
    enabled: config.rerankDiversityEnabled,
    mmrLambda: config.rerankDiversityMmrLambda,
    maxPerDomain: config.rerankDiversityMaxPerDomain,
  };
  const authority = {
    enabled: config.rerankAuthorityEnabled,
    weight: config.rerankAuthorityWeight,
  };

  const metricsSink = deps.metricsSink;
  /** 打点：一条结构化 debug 行 + 可选回调（互不影响正常 markdown 输出）。 */
  const emitMetrics = (m: SearchMetrics): void => {
    try {
      logger.debug(`METRICS ${JSON.stringify(m)}`);
    } catch {
      /* 打点失败不影响搜索 */
    }
    metricsSink?.(m);
  };

  async function search(params: SearchParams): Promise<SearchOutcome> {
    const tStart = performance.now();
    // 反向图搜（ADR-0010）：类别命中才拉起网关侧附加源。命中时把类别名归一成
    // 规范写法再转发（searxng 按字面匹配类别）；未命中则参数逐字不变。
    const reverseCategory = config.searchReverseImageCategory;
    const reverseImage =
      config.searchReverseImageEnabled && isReverseImageQuery(params.categories, reverseCategory);
    const categories = reverseImage ? canonicalizeCategories(params.categories, reverseCategory) : params.categories;
    const effParams: SearchParams = categories === params.categories ? params : { ...params, categories };
    const imageQuery = isImageQuery(effParams.categories, reverseImage ? [reverseCategory] : []);
    // 反向图搜：图来自 query 里的 URL，或来自本地文件（image_path）；两者互斥
    const imageUrl = reverseImage ? extractImageUrl(effParams.query) : undefined;
    const imagePath = reverseImage ? effParams.imagePath : undefined;
    if (reverseImage && imageUrl && imagePath) {
      return {
        ok: false,
        code: ErrorCodes.SEARCH_INVALID,
        text: withCode(ErrorCodes.SEARCH_INVALID, "反向图搜：query 里的图片 URL 与 image_path 只能给一个。"),
      };
    }
    if (effParams.imagePath && !reverseImage) {
      return {
        ok: false,
        code: ErrorCodes.SEARCH_INVALID,
        text: withCode(
          ErrorCodes.SEARCH_INVALID,
          `image_path 只在以图搜图时可用：请在 categories 里加上 ${reverseCategory || "search_by_image"}（当前该能力可能未启用）。`,
        ),
      };
    }
    const enabled = await getEnabledEngines();
    const quota = await getQuota();
    const batches = planEngineBatches(effParams, config, enabled, quota);
    const limit = params.numResults ?? config.searchMaxResults;
    // 本地图请求绕开搜索缓存：同一路径的文件内容随时会变，缓存会给出错的结果
    const cacheable = !effParams.imagePath;
    const key = cacheKey(effParams, batches.map((b) => b.engines), corpus?.namespace ?? "");
    const cached = cacheable ? cache.get(key) : undefined;
    if (cached !== undefined) {
      logger.debug(`search cache hit: "${params.query}"`);
      emitMetrics({
        query: params.query,
        cacheHit: true,
        totalMs: performance.now() - tStart,
        preMs: performance.now() - tStart,
        upstreamMs: 0,
        upstreamBatches: 0,
        upstreamRaw: 0,
        engineCounts: {},
        localMs: 0,
        mergeMs: 0,
        renderMs: 0,
        residualMs: 0,
        semantic: null,
        degraded: false,
      });
      return { ok: true, text: cached, cacheHit: true };
    }

    // 本地图片：读取 + 三重校验（常规文件 / 大小 / magic bytes 是图片），
    // 失败直接返回明确错误，不进后续流程（ADR-0011）
    let localImage: LocalImage | undefined;
    if (imagePath) {
      const loaded = await loadLocalImage(imagePath, config.searchReverseImageLocalMaxBytes);
      if (!loaded.ok) {
        const errText = `反向图搜：本地图片不可用（${loaded.error.kind}）——${loaded.error.message}`;
        logger.debug(errText);
        return { ok: false, code: ErrorCodes.SEARCH_INVALID, text: withCode(ErrorCodes.SEARCH_INVALID, errText) };
      }
      localImage = loaded.image;
      logger.debug(`反向图搜：本地图片 ${localImage.filename} ${localImage.mime} ${localImage.size}B`);
    }

    const release = await sem.acquire();
    const preMs = performance.now() - tStart;
    // 语义层：query 向量不依赖候选 → 先起 Promise，与上游 searxng 召回 overlap（省一次串行等待）。
    // provider/corpus 缺一即无语义层，无需发起；图片查询不走语义层（见 selectImageResults）；
    // catch 兜底避免未被消费时产生 unhandled rejection。
    let queryEmbed: Promise<EmbedResult> | undefined;
    if (provider && corpus && !imageQuery) {
      queryEmbed = provider.embed([params.query], "query");
      queryEmbed.catch(() => undefined);
    }
    // 反向图搜（ADR-0010/0011）：网关侧附加源 trace.moe 与 searxng 并发。
    // 图有两个来源：query 里的图片 URL（URL 输入），或本地文件 image_path。
    // 本地文件时 trace.moe 走 multipart 直传（图不外流）；要让 searxng 的 tineye
    // 参与，还得多一步「发布到公网图床」——TinEye 是从它自己的服务器拉图的。
    const tReverse = performance.now();
    let traceMoePromise: Promise<TraceMoeCall> | undefined;
    if (reverseImage && config.searchReverseImageSources.includes("tracemoe")) {
      if (localImage) {
        traceMoePromise = searchTraceMoeUpload(
          config.searchTraceMoeUrl,
          config.searchTraceMoeTimeoutMs,
          localImage.bytes,
          localImage.filename,
          localImage.mime,
          config.searchTraceMoeMaxResults,
        );
      } else if (imageUrl) {
        traceMoePromise = searchTraceMoe(
          config.searchTraceMoeUrl,
          config.searchTraceMoeTimeoutMs,
          imageUrl,
          config.searchTraceMoeMaxResults,
        );
      }
      traceMoePromise?.catch(() => undefined);
    }
    let publish: PublishResult | undefined;
    let publishMs = 0;
    if (localImage && config.searchReverseImagePublishEnabled) {
      const tPublish = performance.now();
      publish = await publishImage(config.searchReverseImagePublishEndpoint, config.searchReverseImagePublishTimeoutMs, localImage);
      publishMs = performance.now() - tPublish;
      logger.debug(`反向图搜：图床发布 ${publish.ok ? "成功" : `失败(${publish.error.kind})`} (${Math.round(publishMs)}ms)`);
    }
    // 发给 searxng 的 query：URL 输入用它自己；本地图用发布到的公网 URL；
    // 本地图且没发布成功 → 没有可给 TinEye 的公网 URL，searxng 这一半跳过。
    const upstreamQuery = localImage ? (publish?.ok ? publish.url : undefined) : effParams.query;
    if (upstreamQuery === undefined) {
      logger.debug("反向图搜：本地图未获得公网 URL，跳过 searxng（tineye 不参与）");
    }
    try {
      // 静默降级：按批次依次查询。**以「本批 rotating 候选是否产出结果」判定成功**：
      // resident 恒有结果，不能作为成功依据（否则会屏蔽 rotating 的换下一家）；
      // rotating 空/未贡献 → 继续下一批；resident 为空时 = 旧行为（非空即止）。
      // 全部批次都无 rotating 贡献时，回退到最后一个有结果的批次（resident 结果仍在）。
      let lastData: SearxngResponse | undefined;
      let lastError: SearchCallError | undefined;
      let latencyMs = 0;
      let upstreamMs = 0;
      let upstreamBatches = 0;

      // 类别感知超时（D18）：academic 等类别的引擎更慢，取该类别配置的超时
      const searxngTimeoutMs = resolveSearxngTimeout(effParams, config);

      if (upstreamQuery !== undefined) {
        for (const batch of batches) {
          const req: SearchRequest = {
            query: upstreamQuery,
            language: effParams.language,
            safeSearch: effParams.safeSearch,
            categories: effParams.categories,
            engines: batch.engines || undefined,
          };

          upstreamBatches++;
          const tUp = performance.now();
          const result = await searchSearxng(config.searxngUrl, searxngTimeoutMs, req);
          upstreamMs += performance.now() - tUp;
          if (!result.ok) {
            lastError = result.error;
            logger.debug(`search engine batch "${batch.engines}" failed (${result.error.kind}), trying next`);
            continue;
          }

          latencyMs += result.latencyMs;
          lastData = result.data;
          if (result.data.results.length === 0) continue;
          if (rotatingContributed(result.data.results, batch.rotating)) break;
          logger.debug(
            `rotating candidate "${batch.rotating.join(",")}" produced no results, trying next batch`,
          );
        }
      }

      // 反向图搜：等网关侧附加源（与上面的 searxng 批次并发），并汇总提示
      const reverse = traceMoePromise ? await traceMoePromise : undefined;
      const reverseMs = performance.now() - tReverse;
      const reverseCount = reverse?.ok ? reverse.results.length : 0;
      const notes: string[] = [];
      if (reverseImage && localImage) {
        if (!config.searchReverseImagePublishEnabled) {
          notes.push(
            "反向图搜：publish 未启用，本地图只走 trace.moe —— tineye 需要公网可达的图片 URL，未参与。",
          );
        } else if (publish && !publish.ok) {
          notes.push(
            `反向图搜：图床发布失败（${publish.error.kind}），tineye 未参与 —— ${publish.error.message}`,
          );
        } else if (publish?.ok) {
          notes.push(
            `反向图搜：本地图已发布到公网图床（${publish.url}，公网可见、到期由对方删除）。`,
          );
        }
      } else if (reverseImage && !imageUrl) {
        notes.push(
          "反向图搜：query 里没有图片 URL（http/https），且未提供 image_path，已跳过图源；searxng 也只在 query 含图片 URL 时触发 tineye。",
        );
      }
      if (reverse && !reverse.ok) {
        notes.push(`反向图搜：网关侧图源 tracemoe 不可用（${reverse.error.kind}）——${reverse.error.message}`);
      } else if (reverse?.ok && reverseCount === 0) {
        const quota = reverse.quotaUsed !== undefined && reverse.quota !== undefined ? `（配额 ${reverse.quotaUsed}/${reverse.quota}）` : "";
        notes.push(`反向图搜：网关侧图源 tracemoe 无匹配${quota}。`);
      }

      if (!lastData && reverseCount === 0) {
        // 上游失败：报错但尽量附语料召回结果
        const e = lastError ?? { kind: "network" as const, message: "no engine available" };
        let code: SearchOutcome["code"] = ErrorCodes.SEARCH_UPSTREAM;
        if (e.kind === "timeout") code = ErrorCodes.SEARCH_TIMEOUT;
        else if (e.kind === "invalid_json") code = ErrorCodes.SEARCH_INVALID;
        const errText = `搜索失败（${e.kind}${e.status ? ` ${e.status}` : ""}）：${e.message}\n\n请稍后重试，或更换关键词。`;
        const noteText = notes.length > 0 ? `\n\n${notes.map((n) => `> ${n}`).join("\n>\n")}` : "";

        let recalled: CleanedResult[] = [];
        // 图片查询不混文本语料（语料是文本库，召回条目对图片查询只算噪声）
        if (!imageQuery) {
          try {
            const r = await mergeAndRank(params.query, [], limit, { provider, corpus, recallK, diversity, authority, queryEmbed });
            recalled = r.results;
          } catch (err) {
            logger.warn(`语料召回失败: ${String(err)}`);
          }
        }
        if (recalled.length > 0) {
          return {
            ok: false,
            code,
            text: withCode(code, `${errText}${noteText}\n\n## 结果（本地语料）\n\n${renderResults(recalled)}`),
          };
        }
        return { ok: false, code, text: withCode(code, `${errText}${noteText}`) };
      }

      // searxng 失败但网关侧图源有结果 → 降级为部分成功（不报错）
      const data: SearxngResponse = lastData ?? { query: upstreamQuery ?? effParams.query, results: [] };
      if (!lastData && upstreamBatches > 0) notes.push("searxng 未返回结果，以下仅来自网关侧图源。");
      // 多源候选合并：按 URL 去重、引擎归属取并集（ADR-0010）
      const candidates = reverse?.ok ? unionResults(data.results, reverse.results) : data.results;
      const rawCount = candidates.length;
      const engineCounts: Record<string, number> = {};
      for (const r of candidates) {
        for (const e of resultEngines(r)) engineCounts[e] = (engineCounts[e] ?? 0) + 1;
      }

      // 轻量重排：绕过 searxng category 分组排序，按 score × boost 降序（语义不可用时的回退顺序）
      const tLocal = performance.now();
      const reranked = rerankResults(candidates, {
        enabled: config.rerankEnabled,
        engineBoost: config.rerankEngineBoost,
      });

      const { results: cleaned, blockedCount } = cleanResults(reranked, {
        maxResultChars: config.searchMaxResultChars,
        minScore: params.minScore,
        shouldBlock: domainFilter.enabled
          ? (host) => isBlocked(host, domainFilter.blocked, domainFilter.allowlist)
          : undefined,
      });
      const localMs = performance.now() - tLocal;

      // 合并语料召回 + 纯语义排序；失败则回退引擎分顺序。
      // 图片查询例外：不 embedding / 不召回 / 不写语料（见 selectImageResults）。
      let ranked: CleanedResult[];
      let semanticTimings: SemanticTimings | null = null;
      let degraded = false;
      const tMerge = performance.now();
      if (imageQuery) {
        ranked = selectImageResults(cleaned, limit, diversity);
      } else {
        ranked = cleaned;
        try {
          const merged = await mergeAndRank(params.query, cleaned, limit, { provider, corpus, recallK, diversity, authority, queryEmbed });
          ranked = merged.results;
          semanticTimings = merged.timings ?? null;
          degraded = merged.degraded;
        } catch (err) {
          logger.warn(`语义重排失败，回退引擎分顺序: ${String(err)}`);
          ranked = cleaned.slice(0, limit);
          degraded = true;
        }
      }
      const mergeMs = performance.now() - tMerge;

      const tRender = performance.now();
      // 本地图请求没有 query 文本，标题用文件名代替（避免渲染出空的 `# Search: `）
      const displayQuery = localImage ? `本地图片 ${localImage.filename}` : effParams.query;
      const rendered = renderSearchMarkdown({
        query: displayQuery,
        raw: data,
        results: ranked,
        latencyMs,
        skipped: blockedCount > 0 ? blockedCount : undefined,
      });
      // 反向图搜的降级/无匹配提示（只在该路径下出现，正常搜索逐字不变）
      const text = notes.length > 0 ? `${rendered}\n\n${notes.map((n) => `> ${n}`).join("\n>\n")}` : rendered;
      const renderMs = performance.now() - tRender;

      const totalMs = performance.now() - tStart;
      emitMetrics({
        query: params.query,
        cacheHit: false,
        totalMs,
        preMs,
        upstreamMs,
        upstreamBatches,
        upstreamRaw: rawCount,
        engineCounts,
        localMs,
        mergeMs,
        renderMs,
        residualMs: totalMs - preMs - upstreamMs - localMs - mergeMs - renderMs,
        semantic: semanticTimings,
        degraded,
        reverseImage: reverse
          ? {
              source: "tracemoe",
              ok: reverse.ok,
              results: reverseCount,
              ms: reverseMs,
              error: reverse.ok ? undefined : reverse.error.kind,
              published: publish ? publish.ok : undefined,
              publishMs: localImage && config.searchReverseImagePublishEnabled ? publishMs : undefined,
            }
          : undefined,
      });

      if (cacheable) cache.set(key, text);
      logger.debug(`search done: "${displayQuery}" (${ranked.length}/${rawCount} results, ${blockedCount} blocked)`);
      return { ok: true, text, cacheHit: false };
    } finally {
      release();
    }
  }

  return { search };
}
