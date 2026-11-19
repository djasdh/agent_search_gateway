import type { RerankSettings, SearchSettings, SearxngSettings } from "../settings/index.js";
import type { DomainFilter } from "../filter/domain-filter.js";
import { isBlocked } from "../filter/domain-filter.js";
import { readFileSync } from "node:fs";
import type { Logger } from "../logger.js";
import { ErrorCodes, withCode } from "../utils/errors.js";
import { Semaphore } from "../utils/semaphore.js";
import { StringCache } from "./cache.js";
import { cleanResults, resultEngines, type CleanResult, type CleanedResult } from "./clean.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import { mmrSelect, registeredDomainOfUrl } from "./embedding/diversity.js";
import { mergeAndRank, type SemanticTimings } from "./embedding/semantic.js";
import type { CorpusStore } from "./embedding/store.js";
import type { EmbedResult } from "./embedding/types.js";
import { mergeCleanedResults, rankNormalize, sortByWeightedScore } from "./fusion.js";
import { loadLocalImage, publishImage, type LocalImage, type PublishResult } from "./image-publish.js";
import { renderResults, renderSearchMarkdown } from "./render.js";
import { rerankResults } from "./rerank.js";
import { extractImageUrl, unionResults } from "./reverse-image.js";
import type { ImageInput, SourceCall } from "./sources.js";
import {
  searchSearxng,
  type SearchCallError,
  type SearchRequest,
  type SearxngResult,
  type SearxngResponse,
} from "./searxng.js";
import { engineProvider, providersForGroup } from "../engines/registry.js";
import type {
  EngineProvider,
  EngineProviderContext,
  GatewaySearchError,
  GatewaySearchPlan,
  GatewaySearchResult,
  GatewaySearchRuntime,
  GatewayUpstreamRuntime,
} from "../engines/provider.js";

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

/**
 * 上游失败类型 → 对外错误码。
 * `auth` 是不可恢复的（需要用户登录），不能混进 `SEARCH_UPSTREAM`（语义是“稍后重试”）。
 */
function errorCodeForKind(
  kind: GatewaySearchError["kind"] | SearchCallError["kind"],
): NonNullable<SearchOutcome["code"]> {
  switch (kind) {
    case "timeout":
      return ErrorCodes.SEARCH_TIMEOUT;
    case "auth":
      return ErrorCodes.SEARCH_AUTH_REQUIRED;
    case "invalid":
    case "invalid_json":
      return ErrorCodes.SEARCH_INVALID;
    default:
      return ErrorCodes.SEARCH_UPSTREAM;
  }
}

export interface SearchService {
  search(params: SearchParams): Promise<SearchOutcome>;
}

/**
 * 广告过滤器来源：固定值（单测/独立使用），或每次搜索时现取。
 * 进程级共享时用 getter，adlist 刷新后所有会话的 searchService 都能看到新过滤器，
 * 不必重建服务（重建会连带清空缓存和并发闸门）。
 */
export type DomainFilterSource = DomainFilter | (() => DomainFilter);

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

/** 解析逗号分隔的 engines / categories（保留原始大小写；比较时再逐项小写）。 */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 网关自管类别（小写）：反向图搜类别（来自配置，不写死）+ 已注册 `gateway.search`
 * provider 通过 `routing()` 声明的类别。
 *
 * 每次搜索现取，不做跨调用缓存：扩展在进程启动时装载，缓存会带来测试间/热重载污染。
 * 单个 provider 的 `routing()` 抛错只跳过它（打 debug），不能影响搜索本身。
 */
function collectGatewayCategories(
  search: SearchSettings,
  ctx: EngineProviderContext,
  logger: Logger,
): Set<string> {
  const cats = new Set<string>();
  const reverseCategory = (search.reverse_image.category ?? "").trim().toLowerCase();
  if (reverseCategory) cats.add(reverseCategory);
  for (const p of providersForGroup("gateway.search")) {
    try {
      for (const c of p.routing(ctx)) {
        const name = c.trim().toLowerCase();
        if (name) cats.add(name);
      }
    } catch (err) {
      logger.debug(`gateway.search provider ${p.id} routing failed: ${String(err)}`);
    }
  }
  return cats;
}

/** 可用引擎示例（按 /config 顺序取前 5 个，避免提示过长）。 */
function availableEngineSample(engines: Set<string>): string {
  return [...engines].slice(0, 5).join(", ");
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
 *   - **resident**（`search.engines.resident`）：未被 disabled、且额度未接近
 *     耗尽（剩余 < `resident_quota_floor`）的引擎，**每一批都带上**；无台账=永不降
 *   - **rotating**（`search.engines.rotating`）：取前 `fanout` 家轮换，批次无结果/不可用时换下一批
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

/** 请求类别里是否出现指定类别名（大小写不敏感，按逗号分隔）。 */
export { hasCategory } from "./category.js";

/**
 * 是否参与通用上游（ADR-0023）：显式 engines 不参与；类别为空或只含 `general` 才参与。
 * 反向图搜 / 空 query 由调用方另行判断。
 */
function usesGeneralUpstream(params: SearchParams): boolean {
  if (splitList(params.engines).length > 0) return false;
  const cats = new Set(splitList(params.categories).map((c) => c.toLowerCase()));
  return cats.size === 0 || (cats.size === 1 && cats.has("general"));
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
export function resolveSearxngTimeout(
  params: SearchParams,
  deps: { search: SearchSettings; searxng: SearxngSettings },
): number {
  const cats = (params.categories ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  for (const c of cats) {
    const t = deps.search.category_timeout_ms?.[c];
    if (t !== undefined) return t;
  }
  return deps.searxng.timeout_ms;
}

export function planEngineBatches(
  params: SearchParams,
  search: SearchSettings,
  enabled: Set<string> | undefined,
  quota: QuotaLedger | undefined,
): EngineBatch[] {
  const explicit = splitList(params.engines);
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

  const resident = search.engines.resident ?? [];
  const rotating = search.engines.rotating ?? [];
  if (resident.length === 0 && rotating.length === 0) return [{ engines: "", rotating: [] }]; // 交给 searxng 默认

  // 常住档：未被 disabled、且额度未接近耗尽 → 每次查询都带上
  const floor = search.resident_quota_floor ?? 0.2;
  const residentUsable = (enabled ? resident.filter((e) => enabled.has(e)) : resident.slice()).filter((e) => {
    const q = quota?.[e];
    return !isExhausted(q) && remainingRatio(q) >= floor;
  });

  // 轮换档：沿用既有台账逻辑（剔除耗尽 / fanout / 紧张压回）
  const filtered = enabled ? rotating.filter((e) => enabled.has(e)) : rotating.slice();
  let usable = filtered.length > 0 ? filtered : rotating.slice();

  if (quota) usable = usable.filter((e) => !isExhausted(quota[e]));

  let fanout = Math.max(1, params.fanout ?? search.fanout_default ?? 1);

  // 余额紧张 → 把扇出压回 1（§9）
  if (quota && fanout > 1 && isQuotaTight(usable, quota, search.quota_tight_threshold)) {
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
  search: SearchSettings,
  enabled: Set<string> | undefined,
  quota: QuotaLedger | undefined,
): string[] {
  return planEngineBatches(params, search, enabled, quota).map((b) => b.engines);
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
  /** 反向图搜（ADR-0010/0012）：各附加源的调用结果；未触发为 undefined。 */
  reverseImage?: {
    /** 逐源结果（并发扇出，顺序即 sources 顺序）。 */
    sources: Array<{ name: string; ok: boolean; results: number; ms: number; error?: string }>;
    /** 等待所有附加源的整体墙钟。 */
    ms: number;
    /** 本地图是否成功发布到公网图床（非本地图请求为 undefined） */
    published?: boolean;
    publishMs?: number;
  };
  /** 通用上游（ADR-0023）：多上游分支逐源记录；未启用通用上游时为 undefined。 */
  generalUpstreams?: Array<{
    id: string;
    ok: boolean;
    results: number;
    ms: number;
    error?: string;
  }>;
}

/** 构造稳定缓存键（搜索参数 + 选中引擎批次 + 参与的通用上游 + 语料命名空间一致）。 */
function cacheKey(params: SearchParams, batches: string[], semanticTag = "", upstreamTag = ""): string {
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
    upstreamTag,
  ]);
}

/**
 * 加载 searxng `/config`（已启用引擎 + 类别声明），一次请求供两处校验/筛选复用。
 * 失败时返回 undefined（调用方退化为「不校验/不剔除」），并做短期负缓存避免反复打网络。
 */
function createSearxngConfigLoader(searxngUrl: string, logger: Logger) {
  let cached: { at: number; config: SearxngConfigSnapshot | undefined } | undefined;
  return async (): Promise<SearxngConfigSnapshot | undefined> => {
    const now = Date.now();
    if (cached && now - cached.at < ENABLED_ENGINES_TTL_MS) return cached.config;
    try {
      const res = await fetch(`${searxngUrl}/config`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        engines?: Array<{ name?: string; enabled?: boolean }>;
        categories?: unknown;
      };
      const engines = new Set<string>();
      for (const e of data.engines ?? []) {
        if (e.name && e.enabled) engines.add(e.name);
      }
      const categories = new Set<string>();
      if (Array.isArray(data.categories)) {
        for (const c of data.categories) {
          if (typeof c === "string" && c.length > 0) categories.add(c);
        }
      }
      const config: SearxngConfigSnapshot = { engines, categories };
      cached = { at: now, config };
      return config;
    } catch (err) {
      logger.debug(`enabled engines fetch failed: ${String(err)}`);
      cached = { at: now, config: undefined };
      return undefined;
    }
  };
}

/**
 * 加载 searxng 插件写入的配额台账（JSON 文件）。
 * 未启用/路径为空/文件不可读/结构非法 → 返回 undefined（调用方退化为现状），
 * 并做短期负缓存避免每请求都打文件系统。
 */
function createQuotaLoader(search: SearchSettings, logger: Logger) {
  let cached: { at: number; ledger: QuotaLedger | undefined } | undefined;
  return async (): Promise<QuotaLedger | undefined> => {
    if (!search.quota_enabled || !search.quota_ledger_path) return undefined;
    const now = Date.now();
    if (cached && now - cached.at < QUOTA_LEDGER_TTL_MS) return cached.ledger;
    try {
      const raw = JSON.parse(readFileSync(search.quota_ledger_path, "utf-8"));
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

/** searxng `/config` 里与参数校验相关的部分（一次请求同时供引擎与类别使用）。 */
export interface SearxngConfigSnapshot {
  /** 已启用的引擎名；可能为空集合（实例没有启用任何引擎）。 */
  engines: Set<string>;
  /** searxng 声明的类别；`/config` 未给出时为空集合。 */
  categories: Set<string>;
}

/**
 * 校验显式 `engines` 是否可用（复用 `/config` 快照，不额外发请求）。
 *
 * 只在 `/config` 成功且引擎集合非空时校验：取不到（网络失败/空响应）时返回
 * undefined 保持旧行为，避免把网关自身的网络问题误报成用户参数错误。
 */
export function validateExplicitFilters(
  params: SearchParams,
  config: SearxngConfigSnapshot | undefined,
): SearchOutcome | undefined {
  if (!config) return undefined;

  const engines = splitList(params.engines);
  if (engines.length > 0 && config.engines.size > 0) {
    if (!engines.some((e) => config.engines.has(e))) {
      return {
        ok: false,
        code: ErrorCodes.SEARCH_INVALID,
        text: withCode(
          ErrorCodes.SEARCH_INVALID,
          `指定引擎不可用：${engines.join(", ")}。当前可用：${availableEngineSample(config.engines)}`,
        ),
      };
    }
  }

  return undefined;
}

/**
 * 未在 searxng `/config` 或网关 provider 中声明的类别：照常搜索，只在结果末尾提示。
 * 不硬拒绝——searxng 的 `/config` 只列 tab 类（如 `other` 不在其中），硬判会误杀。
 */
export function unknownCategoryNote(
  params: SearchParams,
  config: SearxngConfigSnapshot | undefined,
  gatewayCategories: ReadonlySet<string> | undefined,
): string | undefined {
  if (!config || config.categories.size === 0) return undefined;
  const known = new Set([...config.categories].map((c) => c.toLowerCase()));
  for (const c of gatewayCategories ?? []) known.add(c.toLowerCase());
  const unknown = splitList(params.categories).filter((c) => !known.has(c.toLowerCase()));
  if (unknown.length === 0) return undefined;
  return `> 注：类别 ${unknown.join(", ")} 未被 searxng 声明，已按普通搜索处理；若为扩展类别，请先安装对应扩展。`;
}

/**
 * 显式过滤（engines/categories）且 0 结果时的提示。
 * 静默返回 0 条容易被误读成「确实没有匹配」，这里点明过滤条件与常见原因。
 */
export function zeroResultFilterNote(params: SearchParams): string | undefined {
  const parts: string[] = [];
  const engines = splitList(params.engines);
  const categories = splitList(params.categories);
  if (engines.length > 0) parts.push(`engines=${engines.join(",")}`);
  if (categories.length > 0) parts.push(`categories=${categories.join(",")}`);
  if (parts.length === 0) return undefined;
  return `> 注：已按 ${parts.join(" / ")} 过滤；0 结果可能是该来源未启用或无匹配。`;
}

/**
 * query 里给出的图源地址是否可用：`new URL` 能解析且协议是 http/https。
 * `extractImageUrl` 只按 `https?://` 抠串，`https://` 这类残串仍会命中，故需再验一次。
 */
function isHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** createSearchService 所需设置切片 + 密钥。 */
export interface SearchSettingsDeps {
  search: SearchSettings;
  rerank: RerankSettings;
  searxng: SearxngSettings;
  saucenao_api_key: string;
  /** DeepSeek 通用上游密钥（secrets.search.deepseek.api_key）。 */
  deepseek_api_key: string;
}

export function createSearchService(
  deps: SearchSettingsDeps,
  domainFilter: DomainFilterSource,
  logger: Logger,
  searchDeps: SearchDeps = {},
): SearchService {
  const { search, rerank, searxng, saucenao_api_key, deepseek_api_key } = deps;
  const providerCtx: EngineProviderContext = {
    config: { search: search as unknown },
    secrets: {
      search: {
        reverse_image: { saucenao: { api_key: saucenao_api_key } },
        deepseek: { api_key: deepseek_api_key },
      },
    },
    logger,
  };
  const cache = new StringCache(search.cache_max_entries, search.cache_ttl_ms);
  const sem = new Semaphore(search.max_concurrent);
  const resolveDomainFilter = typeof domainFilter === "function" ? domainFilter : () => domainFilter;
  const getSearxngConfig = createSearxngConfigLoader(searxng.url, logger);
  const getQuota = createQuotaLoader(search, logger);
  const provider = searchDeps.embeddingProvider ?? null;
  const corpus = searchDeps.corpus ?? null;
  const recallK = searchDeps.recallK ?? 10;
  const diversity = {
    enabled: rerank.diversity.enabled,
    mmrLambda: rerank.diversity.mmr_lambda,
    maxPerDomain: rerank.diversity.max_per_domain,
  };
  const authority = {
    enabled: rerank.authority.enabled,
    weight: rerank.authority.weight,
  };

  const metricsSink = searchDeps.metricsSink;
  /** 打点：一条结构化 debug 行 + 可选回调（互不影响正常 markdown 输出）。 */
  const emitMetrics = (m: SearchMetrics): void => {
    try {
      logger.debug(`METRICS ${JSON.stringify(m)}`);
    } catch {
      /* 打点失败不影响搜索 */
    }
    metricsSink?.(m);
  };

  /**
   * 网关侧文本源（ADR-0014）：类别命中时完全不经过 searxng。
   * 只保留该源候选 —— 不召回本地语料，避免把普通网页混进「只搜微博」的结果。
   */
  async function searchGatewaySource(
    provider: EngineProvider,
    runtime: GatewaySearchRuntime,
    params: SearchParams,
    plan: GatewaySearchPlan,
    tStart: number,
  ): Promise<SearchOutcome> {
    const requested = params.numResults ?? search.max_results;
    const limit = Math.min(requested, search.max_results_cap);
    const query = (params.query ?? "").trim();
    const hot = plan.hot;
    const displayQuery = hot ? `${provider.displayName}热搜` : query;
    const release = await sem.acquire();
    const preMs = performance.now() - tStart;
    try {
      if (!hot && query === "") {
        return {
          ok: false,
          code: ErrorCodes.SEARCH_INVALID,
          text: withCode(ErrorCodes.SEARCH_INVALID, `${provider.displayName}搜索需要一个关键词。`),
        };
      }
      const tUp = performance.now();
      const source = await runtime.search(query, { hot, limit }, providerCtx);
      const upstreamMs = performance.now() - tUp;

      if (!source.ok) {
        const code = errorCodeForKind(source.error.kind);
        const hint =
          source.error.kind === "auth" && provider.authHint
            ? `\n\n处理：${provider.authHint}`
            : "";
        return {
          ok: false,
          code,
          text: withCode(
            code,
            `${provider.displayName}${hot ? "热搜" : "搜索"}失败（${source.error.kind}）：${source.error.message}${hint}`,
          ),
        };
      }

      const data: SearxngResponse = { query: displayQuery, results: source.results };
      const engineCounts: Record<string, number> = {};
      for (const r of data.results) {
        const name = r.engine ?? provider.name;
        engineCounts[name] = (engineCounts[name] ?? 0) + 1;
      }

      const tLocal = performance.now();
      const reranked = rerankResults(data.results, {
        enabled: rerank.enabled,
        engineBoost: rerank.engine_boost,
      });
      const filter = resolveDomainFilter();
      const { results: cleaned, blockedCount } = cleanResults(reranked, {
        maxResultChars: search.max_result_chars,
        minScore: params.minScore,
        shouldBlock: filter.enabled
          ? (host) => isBlocked(host, filter.blocked, filter.allowlist)
          : undefined,
      });
      const ranked = cleaned.slice(0, limit);
      const localMs = performance.now() - tLocal;

      const tRender = performance.now();
      const rendered = renderSearchMarkdown({
        query: displayQuery,
        raw: data,
        results: ranked,
        latencyMs: source.latencyMs,
        skipped: blockedCount > 0 ? blockedCount : undefined,
        cappedAt: requested > limit ? limit : undefined,
        availableCount: cleaned.length,
      });
      const renderMs = performance.now() - tRender;

      const totalMs = performance.now() - tStart;
      emitMetrics({
        query: displayQuery,
        cacheHit: false,
        totalMs,
        preMs,
        upstreamMs,
        upstreamBatches: 1,
        upstreamRaw: data.results.length,
        engineCounts,
        localMs,
        mergeMs: 0,
        renderMs,
        residualMs: totalMs - preMs - upstreamMs - localMs - renderMs,
        semantic: null,
        degraded: false,
      });

      logger.debug(
        `${provider.name} ${hot ? "hot" : "search"} done: "${displayQuery}" (${ranked.length}/${cleaned.length} results)`,
      );
      return { ok: true, text: rendered, cacheHit: false };
    } finally {
      release();
    }
  }

  async function runSearch(params: SearchParams): Promise<SearchOutcome> {
    const tStart = performance.now();
    // query 先 trim：`""` 与 `"   "` 行为一致，避免纯空白串空耗上游后伪装成“0 结果成功”。
    params = { ...params, query: (params.query ?? "").trim() };
    // 反向图搜（ADR-0010）：类别命中才拉起网关侧附加源。命中时把类别名归一成
    // 规范写法再转发（searxng 按字面匹配类别）；未命中则参数逐字不变。
    const reverseCategory = search.reverse_image.category;
    const reverseImage =
      search.reverse_image.enabled && isReverseImageQuery(params.categories, reverseCategory);
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
    // 以图搜图但既没有 image_path、query 也不是可用图片 URL：
    // 继续往下会静默降级成普通网页搜索（返回一堆百科/网页结果），这里显式报参数错误。
    // query 为空（只靠 image_path 或纯提示）保持既有「已跳过图源」分支，不在这里拦。
    const reverseIntent = reverseImage || isReverseImageQuery(effParams.categories, reverseCategory);
    if (reverseIntent && !imagePath) {
      const queryText = (effParams.query ?? "").trim();
      if (queryText !== "" && !isHttpUrl(imageUrl ?? queryText)) {
        return {
          ok: false,
          code: ErrorCodes.SEARCH_INVALID,
          text: withCode(
            ErrorCodes.SEARCH_INVALID,
            "以图搜图需要一个图片 URL 或 image_path（当前 query 不是图片 URL）。请把图片地址直接作为 query，或改用 categories=general 做普通网页搜索。",
          ),
        };
      }
    }
    // 网关侧文本源（ADR-0014）：类别命中即走 provider，完全不请求 searxng。
    // 注意顺序：在 getSearxngConfig() 之前返回，避免为文本源查询白打一次 searxng /config。
    if (!reverseImage) {
      for (const p of providersForGroup("gateway.search")) {
        const runtime = p.runtime;
        if (!runtime || runtime.kind !== "search") continue;
        if (!p.available(providerCtx)) continue;
        if (p.enabled && !p.enabled(providerCtx)) continue;
        const plan = runtime.plan(params.categories, providerCtx);
        if (!plan) continue;
        return searchGatewaySource(p, runtime, effParams, plan, tStart);
      }
    }

    // 通用上游（ADR-0023）：仅 general 查询、无显式 engines、query 非空、非反向图搜时参与。
    // `enabled` 缺省视为 true；启用但 `available()` 为 false（缺 API key）→ 记下来，
    // 末尾提示且本次结果不写缓存（结果不完整）。
    const candidateUpstreams =
      !reverseImage && effParams.query !== "" && usesGeneralUpstream(effParams)
        ? providersForGroup("gateway.upstream").filter((p) => p.runtime?.kind === "upstream")
        : [];
    const enabledUpstreams = candidateUpstreams.filter((p) => p.enabled?.(providerCtx) ?? true);
    const activeUpstreams = enabledUpstreams.filter((p) => p.available(providerCtx));
    const unavailableUpstreams = enabledUpstreams.filter((p) => !p.available(providerCtx));

    const searxngConfig = await getSearxngConfig();
    const enabled = searxngConfig?.engines;
    // 显式 engines/categories 与 /config 不符 → 参数错误（取不到配置时保持旧行为）。
    // 网关自管类别按当前已注册 provider 动态收集，只有请求确实带类别时才调用 routing()。
    const gatewayCategories =
      splitList(effParams.categories).length > 0
        ? collectGatewayCategories(search, providerCtx, logger)
        : undefined;
    const invalid = validateExplicitFilters(effParams, searxngConfig);
    if (invalid) return invalid;
    const quota = await getQuota();
    const batches = planEngineBatches(effParams, search, enabled, quota);
    // 单一上限（search.max_results_cap）：agent 请求超过即按上限截断，不报错；
    // 渲染时据 cappedAt/availableCount 在末尾附加说明。
    const requested = params.numResults ?? search.max_results;
    const limit = Math.min(requested, search.max_results_cap);
    // 本地图请求绕开搜索缓存：同一路径的文件内容随时会变，缓存会给出错的结果
    const cacheable = !effParams.imagePath;
    // 参与的通用上游 id 进缓存键：开关/密钥变化后不会复用另一组上游的结果
    const upstreamTag = activeUpstreams
      .map((p) => p.id)
      .sort()
      .join(",");
    const key = cacheKey(effParams, batches.map((b) => b.engines), corpus?.namespace ?? "", upstreamTag);
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
      const loaded = await loadLocalImage(imagePath, search.reverse_image.local_max_bytes);
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
    // 通用上游（ADR-0023）：与 searxng 并发启动（在信号量之后、批次之前），
    // 每个 promise 用 catch 兜底成结构化失败，绝不抛裸异常。
    const generalTasks = activeUpstreams.map((p) => {
      const runtime = p.runtime as GatewayUpstreamRuntime;
      const fail = (err: unknown): GatewaySearchResult => ({
        ok: false,
        error: { kind: "network", message: err instanceof Error ? err.message : String(err) },
        latencyMs: 0,
      });
      let promise: Promise<GatewaySearchResult>;
      try {
        promise = runtime
          .search(
            effParams.query,
            {
              limit,
              minScore: params.minScore,
              language: effParams.language,
              safeSearch: effParams.safeSearch,
            },
            providerCtx,
          )
          .catch(fail);
      } catch (err) {
        // provider 同步抛错（不是 rejected promise）也按失败处理
        promise = Promise.resolve(fail(err));
      }
      promise.catch(() => undefined);
      return { provider: p, promise };
    });
    // 语义层：query 向量不依赖候选 → 先起 Promise，与上游 searxng 召回 overlap（省一次串行等待）。
    // provider/corpus 缺一即无语义层，无需发起；图片查询不走语义层（见 selectImageResults）；
    // catch 兜底避免未被消费时产生 unhandled rejection。
    let queryEmbed: Promise<EmbedResult> | undefined;
    if (provider && corpus && !imageQuery) {
      queryEmbed = provider.embed([params.query], "query");
      queryEmbed.catch(() => undefined);
    }
    // 反向图搜（ADR-0010/0012）：网关侧附加源与 searxng 并发。
    // 图有两个来源：query 里的图片 URL（URL 输入），或本地文件 image_path。
    // 本地文件走 multipart 直传（图不外流）；要让 searxng 的 tineye 参与，
    // 还得多一步「发布到公网图床」——TinEye 是从它自己的服务器拉图的。
    const tReverse = performance.now();
    const imageInput: ImageInput | undefined = localImage
      ? { kind: "bytes", bytes: localImage.bytes, filename: localImage.filename, mime: localImage.mime }
      : imageUrl
        ? { kind: "url", url: imageUrl }
        : undefined;
    // 按 sources 清单并发扇出；未知 / 未启用的源直接忽略，每个源内部都不抛裸异常
    const sourceTasks: Array<{ name: string; promise: Promise<SourceCall> }> = [];
    if (reverseImage && imageInput) {
      for (const name of search.reverse_image.sources) {
        const p = engineProvider("gateway.reverse_image", name);
        const runtime = p?.runtime;
        if (!p || !runtime || runtime.kind !== "reverse_image") continue;
        if (!p.available(providerCtx)) {
          logger.debug(`反向图搜：${name} 未配置/未启用，跳过该源`);
          continue;
        }
        sourceTasks.push({ name, promise: runtime.search(imageInput, providerCtx) });
      }
      for (const t of sourceTasks) t.promise.catch(() => undefined);
    }
    let publish: PublishResult | undefined;
    let publishMs = 0;
    if (localImage && search.reverse_image.publish.enabled) {
      const tPublish = performance.now();
      publish = await publishImage(search.reverse_image.publish.endpoint, search.reverse_image.publish.timeout_ms, localImage);
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

      // 类别感知超时（D18）：science 等类别的引擎更慢，取该类别配置的超时
      const searxngTimeoutMs = resolveSearxngTimeout(effParams, { search, searxng });

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
          const result = await searchSearxng(searxng.url, searxngTimeoutMs, req);
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

      // 通用上游（ADR-0023）：searxng 批次结束后统一等待（此前与批次并发）
      const generalResults = await Promise.all(
        generalTasks.map(async (t) => ({ ...t, result: await t.promise })),
      );

      // 反向图搜：等所有附加源（与上面的 searxng 批次并发），逐源汇总提示
      const sourceResults = await Promise.all(
        sourceTasks.map(async (t) => ({ name: t.name, result: await t.promise })),
      );
      const reverseMs = performance.now() - tReverse;
      const reverseCount = sourceResults.reduce((n, s) => n + (s.result.ok ? s.result.results.length : 0), 0);
      const notes: string[] = [];
      if (reverseImage && localImage) {
        if (!search.reverse_image.publish.enabled) {
          notes.push(
            "反向图搜：publish 未启用，本地图只走直传的附加源 —— tineye 需要公网可达的图片 URL，未参与。",
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
      for (const { name, result } of sourceResults) {
        if (!result.ok) {
          notes.push(`反向图搜：网关侧图源 ${name} 不可用（${result.error.kind}）——${result.error.message}`);
          continue;
        }
        if (result.results.length === 0) {
          const quota =
            result.quotaUsed !== undefined && result.quota !== undefined
              ? `（配额 ${result.quotaUsed}/${result.quota}）`
              : "";
          const rem = result.remaining;
          const remaining =
            rem && (rem.short !== undefined || rem.long !== undefined)
              ? `（剩余 ${rem.short ?? "?"}/30s、${rem.long ?? "?"}/天）`
              : "";
          notes.push(`反向图搜：网关侧图源 ${name} 无匹配${quota}${remaining}。`);
        }
      }

      // 已启用但不可用的源：先记提示，错误路径也能看到。
      for (const p of unavailableUpstreams) {
        logger.warn(`通用上游 ${p.id} 已启用但不可用（未配置 API key），已跳过`);
        notes.push(`${p.displayName} 上游已启用但不可用（未配置 API key）；已跳过。`);
      }

      const data: SearxngResponse = lastData ?? { query: upstreamQuery ?? effParams.query, results: [] };
      const tLocal = performance.now();
      const filter = resolveDomainFilter();
      const shouldBlock = filter.enabled
        ? (host: string) => isBlocked(host, filter.blocked, filter.allowlist)
        : undefined;

      // 通用上游结果先按源内规则清洗（provider 已处理 minScore），
      // 用它判断是否真正贡献候选：全部被过滤时回落单上游路径，保持 searxng 行为不变。
      const cleanedUpstreams: Array<{
        provider: EngineProvider;
        clean: CleanResult;
        latencyMs: number;
      }> = [];
      for (const { provider: p, result } of generalResults) {
        if (!result.ok) continue;
        cleanedUpstreams.push({
          provider: p,
          clean: cleanResults(result.results, {
            maxResultChars: search.max_result_chars,
            minScore: undefined,
            shouldBlock,
          }),
          latencyMs: result.latencyMs,
        });
      }
      const upstreamProvided = cleanedUpstreams.some((x) => x.clean.results.length > 0);

      if (!lastData && reverseCount === 0 && !upstreamProvided) {
        // 上游失败：报错但尽量附语料召回结果
        const e = lastError ?? { kind: "network" as const, message: "no engine available" };
        // 通用上游失败（ADR-0023）：auth 优先映射为 SEARCH_AUTH_REQUIRED
        const failedGeneral: Array<{ displayName: string; error: GatewaySearchError }> = [];
        for (const { provider: p, result } of generalResults) {
          if (!result.ok) failedGeneral.push({ displayName: p.displayName, error: result.error });
        }
        const searxKind: string | undefined = lastError?.kind;
        const anyAuth = searxKind === "auth" || failedGeneral.some((f) => f.error.kind === "auth");
        const code = anyAuth
          ? ErrorCodes.SEARCH_AUTH_REQUIRED
          : errorCodeForKind(lastError?.kind ?? failedGeneral[0]?.error.kind ?? e.kind);
        let errText = `搜索失败（${e.kind}${e.status ? ` ${e.status}` : ""}）：${e.message}\n\n请稍后重试，或更换关键词。`;
        if (generalTasks.length > 0) {
          // 多上游：错误文本同时点明 searxng 与各通用上游的原因
          const reasons: string[] = [];
          if (lastError) {
            reasons.push(
              `searxng（${lastError.kind}${lastError.status ? ` ${lastError.status}` : ""}）：${lastError.message}`,
            );
          } else {
            reasons.push("searxng：无可用引擎");
          }
          for (const { provider: p, result } of generalResults) {
            reasons.push(
              result.ok
                ? `${p.displayName}：无结果`
                : `${p.displayName}（${result.error.kind}）：${result.error.message}`,
            );
          }
          errText = `搜索失败：${reasons.join("；")}\n\n请稍后重试，或更换关键词。`;
        }
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

      // 通用上游（ADR-0023）：失败静默降级，逐条提示；已启用但缺 key 的源同样提示
      for (const { provider: p, result } of generalResults) {
        if (result.ok) continue;
        const hint = result.error.kind === "auth" && p.authHint ? ` 处理：${p.authHint}` : "";
        notes.push(
          `${p.displayName} 上游不可用（${result.error.kind}）——${result.error.message}；以下结果不含 ${p.displayName}。${hint}`,
        );
      }
      // searxng 失败但网关侧图源/通用上游有结果 → 降级为部分成功（不报错）
      if (!lastData && upstreamBatches > 0) {
        notes.push(
          upstreamProvided
            ? "searxng 未返回结果，以下结果来自通用上游。"
            : "searxng 未返回结果，以下仅来自网关侧图源。",
        );
      }

      let rawCount: number;
      let engineCounts: Record<string, number>;
      let cleaned: CleanedResult[];
      let blockedCount: number;

      if (upstreamProvided) {
        // 多上游（ADR-0023）：各源原始分不可比 → 源内名次归一化后合并，再按 score × engine_boost 排序。
        // 这里不再调用 rerankResults，避免二次 boost。
        const searxngOrdered = rerank.enabled ? sortByWeightedScore(data.results, {}) : data.results;
        const searxngClean = cleanResults(searxngOrdered, {
          maxResultChars: search.max_result_chars,
          minScore: params.minScore,
          shouldBlock,
        });
        const sourceLists: CleanedResult[][] = [rankNormalize(searxngClean.results)];
        blockedCount = searxngClean.blockedCount;

        for (const { clean } of cleanedUpstreams) {
          // provider 已按源内 minScore 过滤（harness 无原始分时不过滤），这里不再做全局 minScore
          blockedCount += clean.blockedCount;
          sourceLists.push(rankNormalize(clean.results));
        }

        const merged = mergeCleanedResults(sourceLists);
        cleaned = sortByWeightedScore(merged, rerank.engine_boost);
        rawCount = merged.length;
        engineCounts = {};
        for (const r of merged) {
          for (const e of resultEngines(r)) engineCounts[e] = (engineCounts[e] ?? 0) + 1;
        }
        // 并发启动：整体耗时取 searxng 与各通用上游的最大值
        latencyMs = Math.max(latencyMs, ...cleanedUpstreams.map((x) => x.latencyMs));
      } else {
        // 多源候选合并：按 URL 去重、引擎归属取并集（ADR-0010/0012）
        let candidates = data.results;
        for (const { result } of sourceResults) {
          if (result.ok && result.results.length > 0) candidates = unionResults(candidates, result.results);
        }
        rawCount = candidates.length;
        engineCounts = {};
        for (const r of candidates) {
          for (const e of resultEngines(r)) engineCounts[e] = (engineCounts[e] ?? 0) + 1;
        }

        const reranked = rerankResults(candidates, {
          enabled: rerank.enabled,
          engineBoost: rerank.engine_boost,
        });
        const cleanOut = cleanResults(reranked, {
          maxResultChars: search.max_result_chars,
          minScore: params.minScore,
          shouldBlock,
        });
        cleaned = cleanOut.results;
        blockedCount = cleanOut.blockedCount;
      }
      const localMs = performance.now() - tLocal;

      // 合并语料召回 + 纯语义排序；失败则回退引擎分顺序。
      // 图片查询例外：不 embedding / 不召回 / 不写语料（见 selectImageResults）。
      let ranked: CleanedResult[];
      let semanticTimings: SemanticTimings | null = null;
      let degraded = false;
      // 截断前的候选总数（默认=清洗后候选；语义层返回合并去重后的总数）
      let candidateCount = cleaned.length;
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
          candidateCount = merged.total;
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
        cappedAt: requested > limit ? limit : undefined,
        availableCount: candidateCount,
      });
      // 反向图搜 / 通用上游的降级与无匹配提示（只在这些路径下出现，正常搜索逐字不变）
      let text = notes.length > 0 ? `${rendered}\n\n${notes.map((n) => `> ${n}`).join("\n>\n")}` : rendered;
      // 显式过滤且最终 0 条：补一句说明，避免被误读成「确实没有匹配」
      const filterNote = ranked.length === 0 ? zeroResultFilterNote(effParams) : undefined;
      if (filterNote) text = `${text}\n\n${filterNote}`;
      const categoryNote = unknownCategoryNote(effParams, searxngConfig, gatewayCategories);
      if (categoryNote) text = `${text}\n\n${categoryNote}`;
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
        reverseImage:
          sourceResults.length > 0
            ? {
                sources: sourceResults.map(({ name, result }) => ({
                  name,
                  ok: result.ok,
                  results: result.ok ? result.results.length : 0,
                  ms: result.ok ? result.latencyMs : 0,
                  error: result.ok ? undefined : result.error.kind,
                })),
                ms: reverseMs,
                published: publish ? publish.ok : undefined,
                publishMs: localImage && search.reverse_image.publish.enabled ? publishMs : undefined,
              }
            : undefined,
        generalUpstreams:
          generalTasks.length > 0
            ? generalResults.map(({ provider: p, result }) => ({
                id: p.id,
                ok: result.ok,
                results: result.ok ? result.results.length : 0,
                ms: result.latencyMs,
                error: result.ok ? undefined : result.error.kind,
              }))
            : undefined,
      });

      // 通用上游降级（缺 key / 调用失败 / searxng 失败）时结果不完整，不写缓存。
      // 反向图搜等无通用上游的路径保持原有缓存行为。
      const upstreamDegraded =
        unavailableUpstreams.length > 0 ||
        generalResults.some((r) => !r.result.ok) ||
        (generalTasks.length > 0 && lastData === undefined);
      if (cacheable && !upstreamDegraded) cache.set(key, text);
      logger.debug(`search done: "${displayQuery}" (${ranked.length}/${rawCount} results, ${blockedCount} blocked)`);
      return { ok: true, text, cacheHit: false };
    } finally {
      release();
    }
  }

  return { search: runSearch };
}
