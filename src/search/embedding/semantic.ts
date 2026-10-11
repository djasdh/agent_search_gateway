import { dot } from "../../utils/vector.js";
import type { CleanedResult } from "../clean.js";
import type { EmbeddingProvider } from "./provider.js";
import type { CorpusStore } from "./store.js";
import type { Vector } from "./types.js";

/** 语义层依赖：两者任一为 null 即降级为引擎分顺序。 */
export interface SemanticOptions {
  provider: EmbeddingProvider | null;
  corpus: CorpusStore | null;
  /** KNN 召回上限。 */
  recallK: number;
}

export interface SemanticResult {
  /** 合并去重、排序、按 limit 截断后的结果。 */
  results: CleanedResult[];
  /** true = embedding 或语料不可用/失败，结果保持入参顺序（引擎分降级）。 */
  degraded: boolean;
}

/** passage 文本：标题 + 内容。 */
function passageText(r: Pick<CleanedResult, "title" | "content">): string {
  return r.content ? `${r.title}\n${r.content}` : r.title;
}

/**
 * 合并上游结果与语料召回，做纯语义重排。
 *
 * 恒开：命中语料向量的复用，未命中的补算并写回；随后用 query 向量 KNN 召回，
 * 与上游按 URL 合并去重（上游优先），最后按 cosine 降序。
 * 任一步 embedding 失败即整体降级（保持入参顺序、不写回半成品）。
 */
export async function mergeAndRank(
  query: string,
  upstream: CleanedResult[],
  limit: number,
  opts: SemanticOptions,
): Promise<SemanticResult> {
  const fallback = (): SemanticResult => ({
    results: upstream.slice(0, limit).map((r) => ({ ...r, origin: "upstream" as const })),
    degraded: true,
  });
  const { provider, corpus } = opts;
  if (!provider || !corpus) return fallback();

  // 1) query 向量
  const q = await provider.embed([query], "query");
  if (!q.ok) return fallback();
  const queryVec: Vector = q.vectors[0];

  // 2) 上游向量：命中复用，未命中补算并写回
  const existing = corpus.get(upstream.map((r) => r.url));
  const missing = upstream.filter((r) => !existing.has(r.url));
  const fresh = new Map<string, Vector>();
  if (missing.length > 0) {
    const e = await provider.embed(missing.map(passageText), "passage");
    if (!e.ok) return fallback();
    const now = Date.now();
    const toStore = missing.map((r, i) => {
      fresh.set(r.url, e.vectors[i]);
      return { url: r.url, title: r.title, content: r.content, fetchedAt: now, vec: e.vectors[i] };
    });
    corpus.put(toStore);
  }

  const simOf = (url: string): number => {
    const v = existing.get(url) ?? fresh.get(url);
    return v ? dot(queryVec, v) : Number.NEGATIVE_INFINITY;
  };

  // 3) 合并：上游 + 语料召回，按 URL 去重（上游优先）
  const seen = new Set(upstream.map((r) => r.url));
  const scored: Array<{ item: CleanedResult; score: number; order: number }> = [];
  let order = 0;
  for (const r of upstream) {
    scored.push({ item: { ...r, origin: "upstream" }, score: simOf(r.url), order: order++ });
  }
  for (const h of corpus.knn(queryVec, opts.recallK)) {
    if (seen.has(h.entry.url)) continue;
    seen.add(h.entry.url);
    scored.push({
      item: {
        title: h.entry.title,
        url: h.entry.url,
        content: h.entry.content,
        engines: [],
        origin: "corpus",
        fetchedAt: h.entry.fetchedAt,
      },
      score: h.similarity,
      order: order++,
    });
  }

  // 4) 纯语义排序（同分保持原顺序）
  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  return { results: scored.slice(0, limit).map((s) => s.item), degraded: false };
}
