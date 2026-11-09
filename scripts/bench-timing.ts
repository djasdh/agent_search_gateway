/**
 * 搜索耗时打点采集：在服务层直接调用 createSearchService，采集 SearchMetrics。
 *
 * 用法（仓库根目录）：
 *   set -a; . ~/.config/agent-search/secrets.env; set +a
 *   npx tsx scripts/bench-timing.ts
 *
 * 产物：
 *   - stdout：每次运行的 JSON 行（前缀 RUN）+ 摘要
 *   - /tmp/opencode/search-metrics.jsonl：原始指标
 *
 * 说明：为测「搜索路径」本身，结果缓存 TTL 置 -1（等价禁用）；
 * 冷/热语料分别用独立临时 sqlite-vec 库，避免受线上 data/corpus/corpus.db 影响。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings } from "../src/settings/index.js";
import { buildDomainFilter } from "../src/filter/domain-filter.js";
import { Logger } from "../src/logger.js";
import { createEmbeddingProvider } from "../src/search/embedding/provider.js";
import { createCorpusStore } from "../src/search/embedding/store.js";
import { createSearchService, type SearchMetrics } from "../src/search/service.js";

const OUT_DIR = "/tmp/opencode";
const OUT_JSONL = join(OUT_DIR, "search-metrics.jsonl");

interface QuerySpec {
  id: string;
  query: string;
  language?: string;
  categories?: string;
}

const QUERIES: QuerySpec[] = [
  { id: "zh-quantum", query: "量子计算最新突破", language: "zh-CN" },
  { id: "zh-python-csv", query: "Python 读取 CSV 文件的几种方法", language: "zh-CN" },
  { id: "en-react", query: "React server components explained", language: "en" },
  { id: "en-sqlitevec", query: "sqlite-vec knn vector search performance", language: "en" },
  { id: "news-nvidia", query: "NVIDIA latest earnings", language: "en", categories: "news" },
];

const COLD_REPS = 2;
const HOT_WARMUP = 1;
const HOT_REPS = 3;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const { settings, secrets } = loadSettings();
  const embedding = settings.embedding;
  const logger = new Logger("error"); // 静默；指标走 metricsSink
  const provider = createEmbeddingProvider(
    {
      provider: embedding.provider,
      baseUrl: embedding.base_url,
      apiKey: secrets.embedding.api_key,
      model: embedding.model,
      dim: embedding.dim,
      timeoutMs: embedding.timeout_ms,
      batchSize: embedding.batch_size,
      concurrency: embedding.concurrency,
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
  console.log(`provider=${namespace} batch=${embedding.batch_size} maxInputChars=${embedding.max_input_chars} recallK=${settings.corpus.recall_k} maxResults=${settings.search.max_results}`);
  console.log(`searxng=${settings.searxng.url} url=${embedding.base_url}`);

  const domainFilter = buildDomainFilter(
    settings.ad_filter.enabled,
    settings.ad_filter.level,
    settings.ad_filter.extra_domains,
    settings.ad_filter.hosts_file,
    settings.ad_filter.allowlist,
  );
  // 禁用结果缓存：TTL=-1 → 每次 get 必过期（测搜索路径本身）
  const benchSearch = { ...settings.search, cache_ttl_ms: -1 };

  const tmpRoot = mkdtempSync(join(OUT_DIR, "searchbench-"));
  const all: Array<Record<string, unknown>> = [];
  const lines: string[] = [];

  const makeCorpus = (name: string) => {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    return createCorpusStore(
      { path: join(dir, "corpus.db"), namespace, dim, ttlMs: settings.corpus.ttl_ms },
      logger,
    );
  };

  const runOnce = async (
    corpus: NonNullable<ReturnType<typeof makeCorpus>>,
    spec: QuerySpec,
    label: string,
  ): Promise<SearchMetrics | null> => {
    let captured: SearchMetrics | null = null;
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
        metricsSink: (m) => {
          captured = m;
        },
      },
    );
    await svc.search({
      query: spec.query,
      language: spec.language,
      categories: spec.categories,
      numResults: settings.search.max_results,
    });
    if (captured) {
      const rec = { label, ...(captured as SearchMetrics) };
      all.push(rec);
      lines.push(`RUN ${JSON.stringify(rec)}`);
    }
    return captured;
  };

  for (const spec of QUERIES) {
    // ---- 冷语料：每个 rep 一个全新空库 ----
    for (let r = 0; r < COLD_REPS; r++) {
      const corpus = makeCorpus(`cold-${spec.id}-${r}`);
      if (!corpus) throw new Error("语料库初始化失败");
      await runOnce(corpus, spec, "cold");
      corpus.close();
    }
    // ---- 热语料：预跑一次填充，再计 3 次 ----
    const hot = makeCorpus(`hot-${spec.id}`);
    if (!hot) throw new Error("语料库初始化失败");
    for (let w = 0; w < HOT_WARMUP; w++) await runOnce(hot, spec, "hot-warmup");
    for (let r = 0; r < HOT_REPS; r++) await runOnce(hot, spec, "hot");
    hot.close();
  }

  writeFileSync(OUT_JSONL, lines.join("\n") + "\n");
  for (const l of lines) console.log(l);
  console.log(`\nwrote ${OUT_JSONL} (${all.length} runs)`);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  logger.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
