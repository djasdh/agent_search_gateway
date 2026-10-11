import type { GatewayConfig } from "../config.js";
import type { DomainFilter } from "../filter/domain-filter.js";
import { isBlocked } from "../filter/domain-filter.js";
import { readFileSync } from "node:fs";
import type { Logger } from "../logger.js";
import { ErrorCodes, withCode } from "../utils/errors.js";
import { Semaphore } from "../utils/semaphore.js";
import { StringCache } from "./cache.js";
import { cleanResults, type CleanedResult } from "./clean.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import { mergeAndRank } from "./embedding/semantic.js";
import type { CorpusStore } from "./embedding/store.js";
import { renderResults, renderSearchMarkdown } from "./render.js";
import { rerankResults } from "./rerank.js";
import { searchSearxng, type SearchCallError, type SearchRequest, type SearxngResponse } from "./searxng.js";

export interface SearchParams {
  query: string;
  language?: string;
  timeRange?: string;
  safeSearch?: string;
  categories?: string;
  engines?: string;
  fanout?: number;
  minScore?: number;
  numResults?: number;
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
 * 计算本次搜索的引擎批次（静默降级的候选序列）：
 * - `engines` 显式指定 → 严格按该集合，一次查完（仍按台账剔除已耗尽者）
 * - 否则按 `config.searchEngines` 优先级取前 `fanout` 家；批次无结果/不可用时换下一批
 * - 跳过 searxng 侧 `enabled:false` 的引擎（如 youcom），使其不占用首个批次
 * - 有台账时:剔除已耗尽引擎；`fanout>1` 按剩余额度降序取前 N；
 *   整体余额低于 `quota_tight_threshold` 时把扇出压回 1
 */
export function planEngines(
  params: SearchParams,
  config: GatewayConfig,
  enabled: Set<string> | undefined,
  quota: QuotaLedger | undefined,
): string[] {
  const explicit = parseEngineList(params.engines);
  if (explicit.length > 0) {
    const usable = quota ? explicit.filter((e) => !isExhausted(quota[e])) : explicit;
    return [(usable.length > 0 ? usable : explicit).join(",")];
  }

  const priority = config.searchEngines ?? [];
  if (priority.length === 0) return [""]; // 未配置引擎清单 → 交给 searxng 默认

  const filtered = enabled ? priority.filter((e) => enabled.has(e)) : priority.slice();
  let usable = filtered.length > 0 ? filtered : priority.slice();

  // 剔除已耗尽引擎
  if (quota) usable = usable.filter((e) => !isExhausted(quota[e]));
  if (usable.length === 0) return [];

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

  const batches: string[] = [];
  for (let i = 0; i < usable.length; i += fanout) {
    batches.push(usable.slice(i, i + fanout).join(","));
  }
  return batches;
}

/** 语义层可选依赖；缺省即关闭（行为与旧版一致）。 */
export interface SearchDeps {
  embeddingProvider?: EmbeddingProvider | null;
  corpus?: CorpusStore | null;
  recallK?: number;
}

/** 构造稳定缓存键（搜索参数 + 选中引擎批次 + 语料命名空间一致）。 */
function cacheKey(params: SearchParams, batches: string[], semanticTag = ""): string {
  return JSON.stringify([
    params.query,
    params.language ?? "",
    params.timeRange ?? "",
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

  async function search(params: SearchParams): Promise<SearchOutcome> {
    const enabled = await getEnabledEngines();
    const quota = await getQuota();
    const batches = planEngines(params, config, enabled, quota);
    const limit = params.numResults ?? config.searchMaxResults;
    const key = cacheKey(params, batches, corpus?.namespace ?? "");
    const cached = cache.get(key);
    if (cached !== undefined) {
      logger.debug(`search cache hit: "${params.query}"`);
      return { ok: true, text: cached, cacheHit: true };
    }

    const release = await sem.acquire();
    try {
      // 静默降级：按批次依次查询，任一批次有结果即止；全部不可用才暴露错误。
      let lastData: SearxngResponse | undefined;
      let lastError: SearchCallError | undefined;
      let latencyMs = 0;

      for (const batch of batches) {
        const req: SearchRequest = {
          query: params.query,
          language: params.language,
          timeRange: params.timeRange,
          safeSearch: params.safeSearch,
          categories: params.categories,
          engines: batch || undefined,
        };

        const result = await searchSearxng(config.searxngUrl, config.searxngTimeoutMs, req);
        if (!result.ok) {
          lastError = result.error;
          logger.debug(`search engine batch "${batch}" failed (${result.error.kind}), trying next`);
          continue;
        }

        latencyMs += result.latencyMs;
        lastData = result.data;
        if (result.data.results.length > 0) break;
      }

      if (!lastData) {
        // 上游失败：报错但尽量附语料召回结果
        const e = lastError ?? { kind: "network" as const, message: "no engine available" };
        let code: SearchOutcome["code"] = ErrorCodes.SEARCH_UPSTREAM;
        if (e.kind === "timeout") code = ErrorCodes.SEARCH_TIMEOUT;
        else if (e.kind === "invalid_json") code = ErrorCodes.SEARCH_INVALID;
        const errText = `搜索失败（${e.kind}${e.status ? ` ${e.status}` : ""}）：${e.message}\n\n请稍后重试，或更换关键词。`;

        let recalled: CleanedResult[] = [];
        try {
          const r = await mergeAndRank(params.query, [], limit, { provider, corpus, recallK });
          recalled = r.results;
        } catch (err) {
          logger.warn(`语料召回失败: ${String(err)}`);
        }
        if (recalled.length > 0) {
          return { ok: false, code, text: withCode(code, `${errText}\n\n## 结果（本地语料）\n\n${renderResults(recalled)}`) };
        }
        return { ok: false, code, text: withCode(code, errText) };
      }

      const data = lastData;
      const rawCount = data.results.length;

      // 轻量重排：绕过 searxng category 分组排序，按 score × boost 降序（语义不可用时的回退顺序）
      const reranked = rerankResults(data.results, {
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

      // 合并语料召回 + 纯语义排序；失败则回退引擎分顺序
      let ranked: CleanedResult[] = cleaned;
      try {
        const merged = await mergeAndRank(params.query, cleaned, limit, { provider, corpus, recallK });
        ranked = merged.results;
      } catch (err) {
        logger.warn(`语义重排失败，回退引擎分顺序: ${String(err)}`);
        ranked = cleaned.slice(0, limit);
      }

      const text = renderSearchMarkdown({
        query: params.query,
        raw: data,
        results: ranked,
        latencyMs,
        skipped: blockedCount > 0 ? blockedCount : undefined,
      });

      cache.set(key, text);
      logger.debug(`search done: "${params.query}" (${ranked.length}/${rawCount} results, ${blockedCount} blocked)`);
      return { ok: true, text, cacheHit: false };
    } finally {
      release();
    }
  }

  return { search };
}
