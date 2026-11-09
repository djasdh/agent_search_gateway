import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/settings/index.js";

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gw-settings-"));
  dirs.push(d);
  return d;
}

function writeFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function load(dir: string, env: NodeJS.ProcessEnv = {}) {
  return loadSettings({
    configPath: join(dir, "gateway.yaml"),
    secretsPath: join(dir, "secrets.yaml"),
    env,
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadSettings (gateway.yaml + secrets.yaml)", () => {
  it("配置文件不存在时抛错", () => {
    const d = tempDir();
    expect(() => load(d)).toThrow(/配置文件不存在/);
  });

  it("空/非法 yaml 抛错", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "");
    expect(() => load(d)).toThrow();
  });

  it("使用默认值当配置省略", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  host: 127.0.0.1\n");
    const { settings, secrets } = load(d);
    expect(settings.gateway.host).toBe("127.0.0.1");
    expect(settings.gateway.port).toBe(3000);
    expect(settings.searxng.url).toBe("http://127.0.0.1:8888");
    expect(settings.flaresolverr.url).toBe("http://127.0.0.1:8192");
    expect(settings.search.max_results).toBe(10);
    expect(settings.ad_filter.level).toBe("ads");
    expect(settings.ad_filter.enabled).toBe(true);
    expect(settings.fetch.max_download_bytes).toBe(1073741824);
    expect(settings.fetch.download_dir).toBe("data/downloads");
    expect(settings.fetch.download_ttl_ms).toBe(604800000);
    expect(settings.fetch.download_max_total_bytes).toBe(4294967296);
    expect(settings.fetch.files_route).toBe(true);
    expect(settings.search.category_timeout_ms).toEqual({});
    expect(settings.search.reverse_image.sources).toEqual(["tracemoe", "saucenao", "baidu"]);
    expect(secrets.gateway.token).toBe("");
    expect(secrets.embedding.api_key).toBe("");
    expect(secrets.search.reverse_image.saucenao.api_key).toBe("");
    expect(secrets.bilibili.http.token).toBe("");
    expect(secrets.browser.proxy_password).toBe("");
  });

  it("读取完整配置", () => {
    const d = tempDir();
    writeFile(
      d,
      "gateway.yaml",
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
  engines:
    resident: [zhihu, bilibili]
    rotating: [exaapi, tavily]
ad_filter:
  level: full
  extra_domains: ["spam.com"]
  allowlist: ["good.com"]
`,
    );
    const { settings } = load(d);
    expect(settings.gateway.host).toBe("0.0.0.0");
    expect(settings.gateway.port).toBe(4000);
    expect(settings.searxng.url).toBe("http://localhost:9999");
    expect(settings.searxng.timeout_ms).toBe(5000);
    expect(settings.search.max_results).toBe(20);
    expect(settings.search.max_result_chars).toBe(300);
    expect(settings.search.engines.resident).toEqual(["zhihu", "bilibili"]);
    expect(settings.search.engines.rotating).toEqual(["exaapi", "tavily"]);
    expect(settings.ad_filter.level).toBe("full");
    expect(settings.ad_filter.extra_domains).toEqual(["spam.com"]);
    expect(settings.ad_filter.allowlist).toEqual(["good.com"]);
  });

  it("读取 secrets.yaml（与设置分离）", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  host: 127.0.0.1\n");
    writeFile(
      d,
      "secrets.yaml",
      `
gateway:
  token: from-secrets
embedding:
  api_key: emb-key
search:
  reverse_image:
    saucenao:
      api_key: sauce-key
bilibili:
  http:
    token: bili-token
browser:
  proxy_password: proxy-pass
`,
    );
    const { secrets } = load(d);
    expect(secrets.gateway.token).toBe("from-secrets");
    expect(secrets.embedding.api_key).toBe("emb-key");
    expect(secrets.search.reverse_image.saucenao.api_key).toBe("sauce-key");
    expect(secrets.bilibili.http.token).toBe("bili-token");
    expect(secrets.browser.proxy_password).toBe("proxy-pass");
  });

  it("secrets.yaml 缺失时密钥全空（不报错）", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  host: 127.0.0.1\n");
    expect(() => load(d)).not.toThrow();
  });

  it("环境变量覆盖 secrets.yaml，空环境变量不覆盖", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  host: 127.0.0.1\n");
    writeFile(d, "secrets.yaml", "gateway:\n  token: file-token\n");
    const { secrets } = load(d, {
      GATEWAY_TOKEN: "env-token",
      EMBEDDING_API_KEY: "env-emb",
      SAUCENAO_API_KEY: "env-sauce",
      BILIBILI_HTTP_TOKEN: "env-bili",
      BROWSER_PROXY_PASSWORD: "env-proxy",
    });
    expect(secrets.gateway.token).toBe("env-token");
    expect(secrets.embedding.api_key).toBe("env-emb");
    expect(secrets.search.reverse_image.saucenao.api_key).toBe("env-sauce");
    expect(secrets.bilibili.http.token).toBe("env-bili");
    expect(secrets.browser.proxy_password).toBe("env-proxy");

    const second = load(d, { EMBEDDING_API_KEY: "" });
    expect(second.secrets.gateway.token).toBe("file-token");
    expect(second.secrets.embedding.api_key).toBe("");
  });

  it("secrets.yaml 权限过宽时给出 warning", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  host: 127.0.0.1\n");
    const sp = writeFile(d, "secrets.yaml", "gateway:\n  token: t\n");
    chmodSync(sp, 0o644);
    const { warnings } = load(d);
    expect(warnings.some((w) => w.includes("权限过宽"))).toBe(true);
  });

  it("旧密钥字段非空 → 迁移报错", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  token: old-token\n");
    expect(() => load(d)).toThrow(/迁移到 secrets\.yaml/);
  });

  it("旧密钥字段为空 → 忽略并 warning", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", 'gateway:\n  host: 127.0.0.1\n  token: ""\n');
    const { settings, warnings } = load(d);
    expect(settings.gateway.host).toBe("127.0.0.1");
    expect(warnings.some((w) => w.includes("gateway.token"))).toBe(true);
  });

  it("未知字段直接报错（strict）", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  host: 127.0.0.1\n  prot: 3000\n");
    expect(() => load(d)).toThrow(/校验失败/);
  });

  it("search.engines 旧平铺数组 → 明确迁移提示", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "search:\n  engines: [exaapi, tavily]\n");
    expect(() => load(d)).toThrow(/平铺数组/);
  });

  it("非法配置抛错", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  port: 99999\n");
    expect(() => load(d)).toThrow(/校验失败/);
  });

  it("非法 level 抛错", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "ad_filter:\n  level: extreme\n");
    expect(() => load(d)).toThrow(/校验失败/);
  });

  it("embedding/corpus 默认关闭", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  host: 127.0.0.1\n");
    const { settings } = load(d);
    expect(settings.embedding.enabled).toBe(false);
    expect(settings.embedding.concurrency).toBe(4);
    expect(settings.corpus.enabled).toBe(false);
    expect(settings.corpus.recall_k).toBe(10);
    expect(settings.corpus.ttl_ms).toBe(2592000000);
  });

  it("读取 embedding/corpus 配置", () => {
    const d = tempDir();
    writeFile(
      d,
      "gateway.yaml",
      `
embedding:
  enabled: true
  provider: ollama
  base_url: http://embed:11434/
  model: bge-m3
  dim: 1024
  concurrency: 2
corpus:
  enabled: true
  recall_k: 5
  ttl_ms: 1000
`,
    );
    const { settings } = load(d);
    expect(settings.embedding.enabled).toBe(true);
    expect(settings.embedding.provider).toBe("ollama");
    expect(settings.embedding.base_url).toBe("http://embed:11434");
    expect(settings.embedding.model).toBe("bge-m3");
    expect(settings.embedding.dim).toBe(1024);
    expect(settings.embedding.concurrency).toBe(2);
    expect(settings.corpus.enabled).toBe(true);
    expect(settings.corpus.recall_k).toBe(5);
    expect(settings.corpus.ttl_ms).toBe(1000);
  });

  it("路径展开 ~，URL 去尾斜杠", () => {
    const d = tempDir();
    writeFile(
      d,
      "gateway.yaml",
      `
searxng:
  url: http://localhost:8888///
search:
  quota_ledger_path: ~/quota.json
bilibili:
  comment_db: ~/bili.sqlite
`,
    );
    const { settings } = load(d);
    expect(settings.searxng.url).toBe("http://localhost:8888");
    expect(settings.search.quota_ledger_path).toBe(join(homedir(), "quota.json"));
    expect(settings.bilibili.comment_db).toBe(join(homedir(), "bili.sqlite"));
  });

  it("rerank.diversity 默认关闭；非法 mmr_lambda 直接报错（不再静默回退）", () => {
    const d = tempDir();
    writeFile(d, "gateway.yaml", "gateway:\n  host: 127.0.0.1\n");
    const { settings } = load(d);
    expect(settings.rerank.diversity.enabled).toBe(false);
    expect(settings.rerank.diversity.mmr_lambda).toBe(0.7);
    expect(settings.rerank.diversity.max_per_domain).toBe(3);

    const d2 = tempDir();
    writeFile(d2, "gateway.yaml", "rerank:\n  diversity:\n    mmr_lambda: 2\n");
    expect(() => load(d2)).toThrow(/校验失败/);
  });
});
