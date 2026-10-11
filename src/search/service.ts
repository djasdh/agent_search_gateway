import type { GatewayConfig } from "../config.js";
import type { DomainFilter } from "../filter/domain-filter.js";
import { isBlocked } from "../filter/domain-filter.js";
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
import { searchSearxng, type SearchRequest } from "./searxng.js";

export interface SearchParams {
  query: string;
  language?: string;
  timeRange?: string;
  safeSearch?: string;
  categories?: string;
  engines?: string;
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

/** 语义层可选依赖；缺省即关闭（行为与旧版一致）。 */
export interface SearchDeps {
  embeddingProvider?: EmbeddingProvider | null;
  corpus?: CorpusStore | null;
  recallK?: number;
}

/** 构造稳定缓存键（与搜索参数 + 语料命名空间一致）。 */
function cacheKey(params: SearchParams, semanticTag = ""): string {
  return JSON.stringify([
    params.query,
    params.language ?? "",
    params.timeRange ?? "",
    params.safeSearch ?? "",
    params.categories ?? "",
    params.engines ?? "",
    params.minScore ?? "",
    params.numResults ?? "",
    semanticTag,
  ]);
}

export function createSearchService(
  config: GatewayConfig,
  domainFilter: DomainFilter,
  logger: Logger,
  deps: SearchDeps = {},
): SearchService {
  const cache = new StringCache(config.searchCacheMaxEntries, config.searchCacheTtlMs);
  const sem = new Semaphore(config.searchMaxConcurrent);
  const provider = deps.embeddingProvider ?? null;
  const corpus = deps.corpus ?? null;
  const recallK = deps.recallK ?? 10;

  async function search(params: SearchParams): Promise<SearchOutcome> {
    const limit = params.numResults ?? config.searchMaxResults;
    const key = cacheKey(params, corpus?.namespace ?? "");
    const cached = cache.get(key);
    if (cached !== undefined) {
      logger.debug(`search cache hit: "${params.query}"`);
      return { ok: true, text: cached, cacheHit: true };
    }

    const release = await sem.acquire();
    try {
      const req: SearchRequest = {
        query: params.query,
        language: params.language,
        timeRange: params.timeRange,
        safeSearch: params.safeSearch,
        categories: params.categories,
        engines: params.engines,
      };

      const result = await searchSearxng(config.searxngUrl, config.searxngTimeoutMs, req);
      if (!result.ok) {
        // 上游失败：报错但尽量附语料召回结果
        const e = result.error;
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

      const { data, latencyMs } = result;
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
