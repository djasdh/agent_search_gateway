import type { GatewayConfig } from "../config.js";
import type { DomainFilter } from "../filter/domain-filter.js";
import { isBlocked } from "../filter/domain-filter.js";
import type { Logger } from "../logger.js";
import { ErrorCodes, withCode } from "../utils/errors.js";
import { Semaphore } from "../utils/semaphore.js";
import { StringCache } from "./cache.js";
import { cleanResults } from "./clean.js";
import { renderSearchMarkdown } from "./render.js";
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

/** 构造稳定缓存键（与搜索参数一致）。 */
function cacheKey(params: SearchParams): string {
  return JSON.stringify([
    params.query,
    params.language ?? "",
    params.timeRange ?? "",
    params.safeSearch ?? "",
    params.categories ?? "",
    params.engines ?? "",
    params.minScore ?? "",
    params.numResults ?? "",
  ]);
}

export function createSearchService(
  config: GatewayConfig,
  domainFilter: DomainFilter,
  logger: Logger,
): SearchService {
  const cache = new StringCache(config.searchCacheMaxEntries, config.searchCacheTtlMs);
  const sem = new Semaphore(config.searchMaxConcurrent);

  async function search(params: SearchParams): Promise<SearchOutcome> {
    const key = cacheKey(params);
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
        const e = result.error;
        let code: SearchOutcome["code"] = ErrorCodes.SEARCH_UPSTREAM;
        if (e.kind === "timeout") code = ErrorCodes.SEARCH_TIMEOUT;
        else if (e.kind === "invalid_json") code = ErrorCodes.SEARCH_INVALID;
        const text = `搜索失败（${e.kind}${e.status ? ` ${e.status}` : ""}）：${e.message}\n\n请稍后重试，或更换关键词。`;
        return { ok: false, code, text: withCode(code, text) };
      }

      const { data, latencyMs } = result;
      const rawCount = data.results.length;

      const { results: cleaned, blockedCount } = cleanResults(data.results, {
        maxResults: params.numResults ?? config.searchMaxResults,
        maxResultChars: config.searchMaxResultChars,
        minScore: params.minScore,
        shouldBlock: domainFilter.enabled
          ? (host) => isBlocked(host, domainFilter.blocked, domainFilter.allowlist)
          : undefined,
      });

      const text = renderSearchMarkdown({
        query: params.query,
        raw: data,
        results: cleaned,
        latencyMs,
        skipped: blockedCount > 0 ? blockedCount : undefined,
      });

      cache.set(key, text);
      logger.debug(`search done: "${params.query}" (${cleaned.length}/${rawCount} results, ${blockedCount} blocked)`);
      return { ok: true, text, cacheHit: false };
    } finally {
      release();
    }
  }

  return { search };
}
