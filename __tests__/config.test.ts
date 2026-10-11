import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gw-test-"));
  dirs.push(d);
  return d;
}

function writeYaml(dir: string, content: string): string {
  const p = join(dir, "gateway.yaml");
  writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadConfig (gateway.yaml)", () => {
  it("文件不存在时抛错", () => {
    expect(() => loadConfig(join(tempDir(), "nonexist.yaml"))).toThrow(/配置文件不存在/);
  });

  it("空/非法 yaml 抛错", () => {
    const d = tempDir();
    writeYaml(d, "");
    expect(() => loadConfig(join(d, "gateway.yaml"))).toThrow();
  });

  it("使用默认值当配置省略", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  host: 127.0.0.1\n");
    const c = loadConfig(p);
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(3000);
    expect(c.token).toBeUndefined();
    expect(c.searxngUrl).toBe("http://127.0.0.1:8888");
    expect(c.flaresolverrUrl).toBe("http://127.0.0.1:8192");
    expect(c.searchMaxResults).toBe(10);
    expect(c.adFilterLevel).toBe("ads");
    expect(c.adFilterEnabled).toBe(true);
  });

  it("读取完整配置", () => {
    const d = tempDir();
    const p = writeYaml(
      d,
      `
gateway:
  host: 0.0.0.0
  port: 4000
searxng:
  url: http://localhost:9999/
  timeout_ms: 5000
search:
  max_results: 20
  max_result_chars: 300
ad_filter:
  level: full
  extra_domains: ["spam.com"]
  allowlist: ["good.com"]
`,
    );
    const c = loadConfig(p);
    expect(c.host).toBe("0.0.0.0");
    expect(c.port).toBe(4000);
    expect(c.searxngUrl).toBe("http://localhost:9999"); // 去尾斜杠
    expect(c.searxngTimeoutMs).toBe(5000);
    expect(c.searchMaxResults).toBe(20);
    expect(c.searchMaxResultChars).toBe(300);
    expect(c.adFilterLevel).toBe("full");
    expect(c.adFilterExtraDomains).toEqual(["spam.com"]);
    expect(c.adFilterAllowlist).toEqual(["good.com"]);
  });

  it("env GATEWAY_TOKEN 覆盖 yaml token", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  token: yaml-token\n");
    const old = process.env.GATEWAY_TOKEN;
    process.env.GATEWAY_TOKEN = "env-token";
    try {
      expect(loadConfig(p).token).toBe("env-token");
    } finally {
      if (old === undefined) delete process.env.GATEWAY_TOKEN;
      else process.env.GATEWAY_TOKEN = old;
    }
  });

  it("空 token 视为未设置", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  token: \"\"\n");
    expect(loadConfig(p).token).toBeUndefined();
  });

  it("非法配置抛错", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  port: 99999\n");
    expect(() => loadConfig(p)).toThrow(/校验失败/);
  });

  it("非法 level 抛错", () => {
    const d = tempDir();
    const p = writeYaml(d, "ad_filter:\n  level: extreme\n");
    expect(() => loadConfig(p)).toThrow(/校验失败/);
  });

  it("embedding/corpus 默认关闭", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  host: 127.0.0.1\n");
    const c = loadConfig(p);
    expect(c.embeddingEnabled).toBe(false);
    expect(c.embeddingConcurrency).toBe(4);
    expect(c.corpusEnabled).toBe(false);
    expect(c.corpusRecallK).toBe(10);
    expect(c.corpusTtlMs).toBe(2592000000);
  });

  it("读取 embedding/corpus 配置", () => {
    const d = tempDir();
    const p = writeYaml(
      d,
      `
gateway:
  host: 127.0.0.1
embedding:
  enabled: true
  provider: ollama
  base_url: http://embed:11434
  model: bge-m3
  dim: 1024
  concurrency: 2
corpus:
  enabled: true
  recall_k: 5
  ttl_ms: 1000
`,
    );
    const c = loadConfig(p);
    expect(c.embeddingEnabled).toBe(true);
    expect(c.embeddingProvider).toBe("ollama");
    expect(c.embeddingBaseUrl).toBe("http://embed:11434");
    expect(c.embeddingModel).toBe("bge-m3");
    expect(c.embeddingDim).toBe(1024);
    expect(c.embeddingConcurrency).toBe(2);
    expect(c.corpusEnabled).toBe(true);
    expect(c.corpusRecallK).toBe(5);
    expect(c.corpusTtlMs).toBe(1000);
  });

  it("env EMBEDDING_API_KEY 覆盖 yaml api_key", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  host: 127.0.0.1\nembedding:\n  api_key: from-yaml\n");
    const old = process.env.EMBEDDING_API_KEY;
    process.env.EMBEDDING_API_KEY = "from-env";
    try {
      expect(loadConfig(p).embeddingApiKey).toBe("from-env");
    } finally {
      if (old === undefined) delete process.env.EMBEDDING_API_KEY;
      else process.env.EMBEDDING_API_KEY = old;
    }
  });

  it("search.engines 分档对象 → resident/rotating + resident_quota_floor", () => {
    const d = tempDir();
    const p = writeYaml(
      d,
      `
gateway:
  host: 127.0.0.1
search:
  engines:
    resident: [zhihu, "zhihu web", bilibili]
    rotating: [exaapi, tavily]
  resident_quota_floor: 0.3
`,
    );
    const c = loadConfig(p);
    expect(c.searchEnginesResident).toEqual(["zhihu", "zhihu web", "bilibili"]);
    expect(c.searchEngines).toEqual(["exaapi", "tavily"]);
    expect(c.searchResidentQuotaFloor).toBe(0.3);
  });

  it("search.engines 旧平铺数组 → 全轮换、resident 空", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  host: 127.0.0.1\nsearch:\n  engines: [exaapi, tavily]\n");
    const c = loadConfig(p);
    expect(c.searchEnginesResident).toEqual([]);
    expect(c.searchEngines).toEqual(["exaapi", "tavily"]);
  });

  it("search.engines 缺省 → 全空清单 + resident_quota_floor 默认 0.2", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  host: 127.0.0.1\n");
    const c = loadConfig(p);
    expect(c.searchEnginesResident).toEqual([]);
    expect(c.searchEngines).toEqual([]);
    expect(c.searchResidentQuotaFloor).toBe(0.2);
  });

  it("rerank.diversity 默认关闭（缺省 = 旧行为）", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  host: 127.0.0.1\n");
    const c = loadConfig(p);
    expect(c.rerankDiversityEnabled).toBe(false);
    expect(c.rerankDiversityMmrLambda).toBe(0.7);
    expect(c.rerankDiversityMaxPerDomain).toBe(3);
  });

  it("读取 rerank.diversity 配置", () => {
    const d = tempDir();
    const p = writeYaml(
      d,
      `
gateway:
  host: 127.0.0.1
rerank:
  enabled: true
  diversity:
    enabled: true
    mmr_lambda: 0.4
    max_per_domain: 2
`,
    );
    const c = loadConfig(p);
    expect(c.rerankDiversityEnabled).toBe(true);
    expect(c.rerankDiversityMmrLambda).toBe(0.4);
    expect(c.rerankDiversityMaxPerDomain).toBe(2);
  });

  it("rerank.diversity 非法 mmr_lambda 时优雅回退默认（不崩）", () => {
    const d = tempDir();
    const p = writeYaml(d, "gateway:\n  host: 127.0.0.1\nrerank:\n  diversity:\n    mmr_lambda: 2\n");
    const c = loadConfig(p);
    expect(c.rerankDiversityMmrLambda).toBe(0.7);
    expect(c.rerankDiversityEnabled).toBe(false);
  });
});
