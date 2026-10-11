import { dot } from "../../utils/vector.js";
import type { CleanedResult } from "../clean.js";
import { authorityScore, combineAuthority } from "./authority.js";
import { mmrSelect, registeredDomainOfUrl } from "./diversity.js";
import type { EmbeddingProvider } from "./provider.js";
import type { CorpusStore } from "./store.js";
import type { EmbedResult, Vector } from "./types.js";

/** 语义层依赖：两者任一为 null 即降级为引擎分顺序。 */
export interface SemanticOptions {
  provider: EmbeddingProvider | null;
  corpus: CorpusStore | null;
  /** KNN 召回上限。 */
  recallK: number;
  /** 多样性重排（MMR + 同域上限）；缺省/disabled 时行为严格等于纯 cosine 序。 */
  diversity?: {
    enabled: boolean;
    mmrLambda: number;
    maxPerDomain: number;
  };
  /** 权威信号：相关分（min-max 归一化后）叠加 `weight · authorityScore(url)`；缺省/disabled 时严格等于纯 cosine 序。 */
  authority?: {
    enabled: boolean;
    weight: number;
  };
  /**
   * 编排层**预先启动**的 query 嵌入，用于与上游 searxng 召回 overlap。
   * 提供时直接 await 复用（不再重复发起 query 嵌入）；缺省时本函数自行嵌入。
   * 契约不变：失败（或未提供且自身嵌入失败）一律整体降级。
   */
  queryEmbed?: Promise<EmbedResult>;
}

/** 候选内 min-max 归一化；非有限值（缺向量）记 0，全同分记 1。 */
function minMaxNormalize(scores: number[]): number[] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of scores) {
    if (!Number.isFinite(s)) continue;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const span = max - min;
  return scores.map((s) => {
    if (!Number.isFinite(s)) return 0;
    if (!(span > 0)) return 1;
    return (s - min) / span;
  });
}

export interface SemanticResult {
  /** 合并去重、排序、按 limit 截断后的结果。 */
  results: CleanedResult[];
  /** true = embedding 或语料不可用/失败，结果保持入参顺序（引擎分降级）。 */
  degraded: boolean;
  /** 分阶段耗时（毫秒）；仅用于打点观测，不影响结果。 */
  timings?: SemanticTimings;
}

/**
 * 语义重排内部的分阶段耗时，供编排层汇总成一条 metrics。
 * 单位均 ms；`totalMs` 为 mergeAndRank 整体墙钟。
 */
export interface SemanticTimings {
  /** query 向量生成。 */
  queryEmbedMs: number;
  /** query 向量维度。 */
  queryVecDim: number;
  /** corpus.get（候选 URL 向量批量取回）。 */
  corpusGetMs: number;
  /** corpus.get 命中条数。 */
  corpusGetHits: number;
  /** passage 向量生成（未命中候选补算）。 */
  passageEmbedMs: number;
  /** 本批需补算的 passage 条数。 */
  passageCount: number;
  /** passage 嵌入实际批次请求数。 */
  passageBatches: number;
  /** corpus.put（补算向量写回）。 */
  corpusPutMs: number;
  /** corpus.knn（query 向量召回）。 */
  corpusKnnMs: number;
  /** KNN 命中条数。 */
  corpusKnnHits: number;
  /** 召回条目补取向量（供 MMR 用）。 */
  recallGetMs: number;
  /** 综合排序（min-max 归一化 + 权威分 + 排序）。 */
  rankMs: number;
  /** 多样性选择（MMR + 同域上限）。 */
  mmrMs: number;
  /** 上游候选数。 */
  upstreamCount: number;
  /** 合并去重后的候选总数（上游 + 召回）。 */
  mergedCount: number;
  /** mergeAndRank 整体墙钟。 */
  totalMs: number;
}

function zeroTimings(): SemanticTimings {
  return {
    queryEmbedMs: 0,
    queryVecDim: 0,
    corpusGetMs: 0,
    corpusGetHits: 0,
    passageEmbedMs: 0,
    passageCount: 0,
    passageBatches: 0,
    corpusPutMs: 0,
    corpusKnnMs: 0,
    corpusKnnHits: 0,
    recallGetMs: 0,
    rankMs: 0,
    mmrMs: 0,
    upstreamCount: 0,
    mergedCount: 0,
    totalMs: 0,
  };
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
  const t0 = performance.now();
  const t = zeroTimings();
  t.upstreamCount = upstream.length;
  const finish = (r: Omit<SemanticResult, "timings">): SemanticResult => ({
    ...r,
    timings: { ...t, totalMs: performance.now() - t0 },
  });
  const fallback = (): SemanticResult =>
    finish({
      results: upstream.slice(0, limit).map((r) => ({ ...r, origin: "upstream" as const })),
      degraded: true,
    });
  const { provider, corpus } = opts;
  if (!provider || !corpus) return fallback();

  // 1) query 向量（编排层可预先启动 Promise 与上游召回 overlap）
  let p = performance.now();
  const q = opts.queryEmbed ? await opts.queryEmbed : await provider.embed([query], "query");
  t.queryEmbedMs = performance.now() - p;
  if (!q.ok) return fallback();
  const queryVec: Vector = q.vectors[0];
  t.queryVecDim = queryVec?.length ?? 0;

  // 2) 上游向量：命中复用，未命中补算并写回
  p = performance.now();
  const existing = corpus.get(upstream.map((r) => r.url));
  t.corpusGetMs = performance.now() - p;
  t.corpusGetHits = existing.size;
  const missing = upstream.filter((r) => !existing.has(r.url));
  const fresh = new Map<string, Vector>();
  if (missing.length > 0) {
    t.passageCount = missing.length;
    p = performance.now();
    const e = await provider.embed(missing.map(passageText), "passage");
    t.passageEmbedMs = performance.now() - p;
    t.passageBatches = e.ok ? (e.batches ?? 0) : 0;
    if (!e.ok) return fallback();
    const now = Date.now();
    const toStore = missing.map((r, i) => {
      fresh.set(r.url, e.vectors[i]);
      return { url: r.url, title: r.title, content: r.content, fetchedAt: now, vec: e.vectors[i] };
    });
    p = performance.now();
    corpus.put(toStore);
    t.corpusPutMs = performance.now() - p;
  }

  const simOf = (url: string): number => {
    const v = existing.get(url) ?? fresh.get(url);
    return v ? dot(queryVec, v) : Number.NEGATIVE_INFINITY;
  };

  // 3) 合并：上游 + 语料召回，按 URL 去重（上游优先）
  const seen = new Set(upstream.map((r) => r.url));
  const scored: Array<{ item: CleanedResult; score: number; order: number; vec?: Vector }> = [];
  let order = 0;
  for (const r of upstream) {
    scored.push({
      item: { ...r, origin: "upstream" },
      score: simOf(r.url),
      order: order++,
      vec: existing.get(r.url) ?? fresh.get(r.url),
    });
  }
  p = performance.now();
  const recallHits = corpus.knn(queryVec, opts.recallK);
  t.corpusKnnMs = performance.now() - p;
  t.corpusKnnHits = recallHits.length;
  // 召回条目默认不在 existing/fresh 里，补取向量供 MMR 的 doc-doc 相似度使用
  const recallUrls = recallHits.filter((h) => !seen.has(h.entry.url)).map((h) => h.entry.url);
  let recallVecs = new Map<string, Vector>();
  if (recallUrls.length > 0) {
    p = performance.now();
    recallVecs = corpus.get(recallUrls);
    t.recallGetMs = performance.now() - p;
  }
  for (const h of recallHits) {
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
      vec: recallVecs.get(h.entry.url),
    });
  }
  t.mergedCount = scored.length;

  // 4) 综合排序：默认纯语义（同分保持原顺序）；启用权威信号时叠加 w·auth
  const auth = opts.authority;
  let ranked = scored;
  p = performance.now();
  if (auth?.enabled) {
    const norms = minMaxNormalize(scored.map((s) => s.score));
    ranked = scored
      .map((s, i) => ({
        ...s,
        score: combineAuthority(norms[i], authorityScore(s.item.url), auth.weight),
      }))
      .sort((a, b) => b.score - a.score || a.order - b.order);
  } else {
    ranked = scored.slice().sort((a, b) => b.score - a.score || a.order - b.order);
  }
  t.rankMs = performance.now() - p;

  // 5) 多样性：MMR 去冗余 + 同注册域上限；关闭时严格等于综合分取前 k
  const div = opts.diversity;
  if (div?.enabled) {
    p = performance.now();
    const chosen = mmrSelect(
      ranked,
      limit,
      { mmrLambda: div.mmrLambda, maxPerDomain: div.maxPerDomain },
      (s) => registeredDomainOfUrl(s.item.url),
    );
    t.mmrMs = performance.now() - p;
    return finish({ results: chosen.map((s) => s.item), degraded: false });
  }

  return finish({ results: ranked.slice(0, limit).map((s) => s.item), degraded: false });
}
