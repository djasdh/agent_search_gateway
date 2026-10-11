/**
 * 真实线上语料命中率探针：复制 data/corpus/corpus.db 到临时目录，
 * 用「全新查询」跑一遍，观察 corpusGetHits / passageCount（冷补算比例）。
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
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
  const config = loadConfig();
  const logger = new Logger("error");
  const provider = createEmbeddingProvider(
    {
      provider: config.embeddingProvider,
      baseUrl: config.embeddingBaseUrl,
      apiKey: config.embeddingApiKey,
      model: config.embeddingModel,
      dim: config.embeddingDim,
      timeoutMs: config.embeddingTimeoutMs,
      batchSize: config.embeddingBatchSize,
      maxInputChars: config.embeddingMaxInputChars,
      queryPrefix: config.embeddingQueryPrefix,
      passagePrefix: config.embeddingPassagePrefix,
    },
    logger,
  );
  const pr = await provider.probe();
  const dim = pr.dim;
  const namespace = `${provider.name}:${provider.model}@${dim}`;
  const root = mkdtempSync("/tmp/opencode/hitrate-");
  const dir = join(root, "corpus");
  mkdirSync(dir, { recursive: true });
  copyFileSync(config.corpusStorePath, join(dir, "corpus.db"));
  const corpus = createCorpusStore(
    { path: join(dir, "corpus.db"), namespace, dim, ttlMs: config.corpusTtlMs },
    logger,
  )!;
  console.log(`copied real corpus (entries=${corpus.stats().entries}) → probe with new queries\n`);
  const domainFilter = buildDomainFilter(
    config.adFilterEnabled,
    config.adFilterLevel,
    config.adFilterExtraDomains,
    config.adFilterHostsFile,
    config.adFilterAllowlist,
  );
  const benchConfig = { ...config, searchCacheTtlMs: -1 };
  const rows: string[] = [];
  for (const q of QUERIES) {
    let m: SearchMetrics | null = null;
    const svc = createSearchService(benchConfig, domainFilter, logger, {
      embeddingProvider: provider,
      corpus,
      recallK: config.corpusRecallK,
      metricsSink: (x) => { m = x; },
    });
    await svc.search({ query: q, numResults: config.searchMaxResults });
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
