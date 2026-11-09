/**
 * 真实线上语料命中率探针：复制 data/corpus/corpus.db 到临时目录，
 * 用「全新查询」跑一遍，观察 corpusGetHits / passageCount（冷补算比例）。
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadSettings } from "../src/settings/index.js";
import { buildDomainFilter } from "../src/filter/domain-filter.js";
import { Logger } from "../src/logger.js";
import { createEmbeddingProvider } from "../src/search/embedding/provider.js";
import { createCorpusStore } from "../src/search/embedding/store.js";
import { createSearchService, type SearchMetrics } from "../src/search/service.js";

const QUERIES = [
  "Rust async runtime tokio tutorial",
  "上海地铁换乘攻略 2025",
  "how to pickle a python object",
  "CSS grid vs flexbox when to use",
  "马斯克 火星计划 最新进展",
];

async function main(): Promise<void> {
  const { settings, secrets } = loadSettings();
  const logger = new Logger("error");
  const embedding = settings.embedding;
  const provider = createEmbeddingProvider(
    {
      provider: embedding.provider,
      baseUrl: embedding.base_url,
      apiKey: secrets.embedding.api_key,
      model: embedding.model,
      dim: embedding.dim,
      timeoutMs: embedding.timeout_ms,
      batchSize: embedding.batch_size,
      maxInputChars: embedding.max_input_chars,
      queryPrefix: embedding.query_prefix,
      passagePrefix: embedding.passage_prefix,
    },
    logger,
  );
  const pr = await provider.probe();
  if (!pr.ok || !pr.dim) throw new Error(`embedding 探针失败: ${pr.detail}`);
  const dim = pr.dim;
  const namespace = `${provider.name}:${provider.model}@${dim}`;
  const root = mkdtempSync("/tmp/opencode/hitrate-");
  const dir = join(root, "corpus");
  mkdirSync(dir, { recursive: true });
  copyFileSync(settings.corpus.store_path, join(dir, "corpus.db"));
  const corpus = createCorpusStore(
    { path: join(dir, "corpus.db"), namespace, dim, ttlMs: settings.corpus.ttl_ms },
    logger,
  )!;
  console.log(`copied real corpus (entries=${corpus.stats().entries}) → probe with new queries\n`);
  const domainFilter = buildDomainFilter(
    settings.ad_filter.enabled,
    settings.ad_filter.level,
    settings.ad_filter.extra_domains,
    settings.ad_filter.hosts_file,
    settings.ad_filter.allowlist,
  );
  const benchSearch = { ...settings.search, cache_ttl_ms: -1 };
  const rows: string[] = [];
  for (const q of QUERIES) {
    let m: SearchMetrics | null = null;
    const svc = createSearchService(
      {
        search: benchSearch,
        rerank: settings.rerank,
        searxng: settings.searxng,
        saucenao_api_key: secrets.search.reverse_image.saucenao.api_key,
        weibo: settings.weibo,
      },
      domainFilter,
      logger,
      {
        embeddingProvider: provider,
        corpus,
        recallK: settings.corpus.recall_k,
        metricsSink: (x) => { m = x; },
      },
    );
    await svc.search({ query: q, numResults: settings.search.max_results });
    const s = (m as SearchMetrics | null)?.semantic as any;
    if (!m) continue;
    const mm = m as SearchMetrics;
    rows.push(
      `${q}\n   raw≈${mm.upstreamRaw} corpusGetHits=${s?.corpusGetHits} passageCount=${s?.passageCount} ` +
        `batches=${s?.passageBatches} knnHits=${s?.corpusKnnHits}\n` +
        `   total=${mm.totalMs.toFixed(0)}ms up=${mm.upstreamMs.toFixed(0)} q=${s?.queryEmbedMs.toFixed(0)} pass=${s?.passageEmbedMs.toFixed(0)}`,
    );
  }
  console.log(rows.join("\n"));
  corpus.close();
  rmSync(root, { recursive: true, force: true });
  logger.close();
}
void main().catch((e) => { console.error(e); process.exit(1); });
