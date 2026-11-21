import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetchService, redactUrl, capOutput } from "../src/fetch/service.js";
import type { FetchServiceDeps } from "../src/fetch/service.js";
import type { BrowserPool } from "../src/browser/pool.js";
import { createFetchProviderRegistry } from "../src/fetch/plugins/registry.js";
import type { FetchProvider } from "../src/fetch/plugins/types.js";
import { FetchStore } from "../src/fetch/store.js";
import { deepMerge, fetchServiceDeps, makeSettings, type DeepPartial } from "./helpers/settings.js";
import { makeMinimalPdf } from "./helpers/pdf-fixture.js";
import type { Settings } from "../src/settings/index.js";
import type { Logger } from "../src/logger.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

function makeConfig(overrides: DeepPartial<Settings> = {}): FetchServiceDeps {
  const base: DeepPartial<Settings> = {
    fetch: { timeout_ms: 3000, max_bytes: 65536, block_private_ips: false },
  };
  return fetchServiceDeps(makeSettings(deepMerge(base, overrides)));
}

interface FakeBrowser {
  pool: BrowserPool;
  calls: number;
  html: string;
  fail?: string;
}

function makeFakeBrowser(html: string, fail?: string): FakeBrowser {
  const state: FakeBrowser = { calls: 0, html, fail, pool: undefined as unknown as BrowserPool };
  state.pool = {
    enabled: true,
    acquireSession: async () => ({
      page: {
        goto: async () => {
          if (state.fail) throw new Error(state.fail);
        },
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        evaluate: async () => 100,
        waitForTimeout: async () => {},
        content: async () => {
          state.calls += 1;
          return state.html;
        },
        url: () => "https://rendered.example/",
      },
      lastActiveAt: Date.now(),
    }),
  } as unknown as BrowserPool;
  return state;
}

// ---- mock 目标站（direct 路径） ----
let targetServer: ReturnType<typeof createHttpServer>;
let targetBase = "";
// ---- mock FlareSolverr ----
let fsServer: ReturnType<typeof createHttpServer>;
let fsBase = "";
let fsCalled = 0;

beforeAll(async () => {
  targetServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/normal") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>普通页</title></head><body><article><h1>正文</h1><p>正常内容</p></article></body></html>");
    } else if (url.pathname === "/blocked403") {
      res.writeHead(403, { "Content-Type": "text/html", "cf-ray": "test123" });
      res.end("<html><body>Access denied by Cloudflare</body></html>");
    } else if (url.pathname === "/shell") {
      // 空壳 SPA
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>SPA</title></head><body><div id='app'></div><script src='/bundle.js'></script></body></html>");
    } else if (url.pathname === "/spa-big") {
      // 大体积 SPA 空壳：旧版按 HTML < 2000 字节判断会漏掉
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><title>大壳 SPA</title></head><body><div id='app'></div><script src='/bundle.js'></script>" +
          "<script>void 0;</script>".repeat(600) +
          "</body></html>",
      );
    } else if (url.pathname === "/short-static") {
      // 短静态页：正文短但有正文节点，不应升级
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>短页</title></head><body><p>一句正文</p><script src='/a.js'></script></body></html>");
    } else if (url.pathname === "/image-shell") {
      // 只有图片 + script：正文为 0，但 markdown 里有可用图片，不应被当成完全空
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>图页</title></head><body><img src='https://example.com/pic.png'><script src='/a.js'></script></body></html>");
    } else if (url.pathname === "/data-image") {
      // data: URI 图片应落盘并换成 /files/<id> 链接
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><title>内嵌图</title></head><body><p>正文内容足够长，不触发渲染。</p>" +
          "<img alt='chart' src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='></body></html>",
      );
    } else if (url.pathname === "/missing404") {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html><body>not found</body></html>");
    } else if (url.pathname === "/status500") {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end("<html><body>server error</body></html>");
    } else if (url.pathname === "/status304") {
      res.writeHead(304);
      res.end();
    } else if (url.pathname === "/empty204") {
      res.writeHead(204);
      res.end();
    } else if (url.pathname === "/pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(makeMinimalPdf("Hello PDF Gateway"));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>ok</body></html>");
    }
  });
  await new Promise<void>((r) => targetServer.listen(0, "127.0.0.1", r));
  targetBase = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}`;

  fsServer = createHttpServer((req, res) => {
    fsCalled++;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          solution: {
            url: "https://rendered.example/",
            status: 200,
            response: "<html><head><title>渲染页</title></head><body><h1>渲染正文</h1><p>浏览器渲染内容</p></body></html>",
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => fsServer.listen(0, "127.0.0.1", r));
  fsBase = `http://127.0.0.1:${(fsServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  targetServer.close();
  fsServer.close();
});

describe("createFetchService 路由", () => {
  it("direct 成功：普通页正常返回 md", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r = await svc.fetch({ url: `${targetBase}/normal` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("普通页");
  });

  it("403 → 升级 FlareSolverr → 返回渲染 md", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const svc = createFetchService(cfg, silentLogger);
    const before = fsCalled;
    const r = await svc.fetch({ url: `${targetBase}/blocked403` });
    expect(r.ok).toBe(true);
    expect(fsCalled).toBe(before + 1);
    if (r.ok) {
      expect(r.text).toContain("渲染页");
      expect(r.text).toContain("浏览器渲染");
    }
  });

  it("空壳 JS → 升级 FlareSolverr", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const svc = createFetchService(cfg, silentLogger);
    const before = fsCalled;
    const r = await svc.fetch({ url: `${targetBase}/shell` });
    expect(r.ok).toBe(true);
    expect(fsCalled).toBe(before + 1);
  });

  it("插件自定义错误码原样透传", async () => {
    const cfg = makeConfig();
    const provider: FetchProvider = {
      id: "custom",
      platform: "custom",
      name: "custom",
      displayName: "Custom",
      capabilities: ["page"],
      match: () => true,
      fetch: async () => ({
        ok: false,
        errorCode: "CUSTOM_DENIED",
        errorMessage: "插件拒绝",
      }),
    };
    cfg.plugins.registry = createFetchProviderRegistry([provider]);
    const svc = createFetchService(cfg, silentLogger);
    const r = await svc.fetch({ url: "https://custom.example/page" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("CUSTOM_DENIED");
      expect(r.text).toContain("[CUSTOM_DENIED]");
    }
  });

  it("404 → 不升级，返回 FETCH_HTTP_STATUS", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const svc = createFetchService(cfg, silentLogger);
    const before = fsCalled;
    const r = await svc.fetch({ url: `${targetBase}/missing404` });
    expect(r.ok).toBe(false);
    expect(fsCalled).toBe(before); // 未调用 FlareSolverr
    if (!r.ok) {
      expect(r.code).toBe("FETCH_HTTP_STATUS");
      expect(r.text).toContain("HTTP 404");
    }
  });

  it("500 → 不升级，返回 FETCH_HTTP_STATUS", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const svc = createFetchService(cfg, silentLogger);
    const before = fsCalled;
    const r = await svc.fetch({ url: `${targetBase}/status500` });
    expect(r.ok).toBe(false);
    expect(fsCalled).toBe(before);
    if (!r.ok) {
      expect(r.code).toBe("FETCH_HTTP_STATUS");
      expect(r.text).toContain("HTTP 500");
    }
  });

  it("304 → 返回 FETCH_HTTP_STATUS，不再报“重定向无 location”", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r = await svc.fetch({ url: `${targetBase}/status304` });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FETCH_HTTP_STATUS");
      expect(r.text).toContain("304");
      expect(r.text).not.toContain("重定向无 location");
    }
  });

  it("204 → ok=true 且给出空响应体提示（不是空字符串）", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r = await svc.fetch({ url: `${targetBase}/empty204` });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text.trim().length).toBeGreaterThan(0);
      expect(r.text).toContain("响应体为空");
    }
  });

  it("flaresolverr.enabled=false → 403 不升级，返回 direct 错误", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase, enabled: false } });
    const svc = createFetchService(cfg, silentLogger);
    const before = fsCalled;
    const r = await svc.fetch({ url: `${targetBase}/blocked403` });
    expect(r.ok).toBe(false);
    expect(fsCalled).toBe(before);
  });

  it("FlareSolverr 失败 → 返回渲染失败错误", async () => {
    // FlareSolverr 指向不可达地址
    const cfg = makeConfig({ flaresolverr: { url: "http://127.0.0.1:1" } });
    const svc = createFetchService(cfg, silentLogger);
    const r = await svc.fetch({ url: `${targetBase}/blocked403` });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("浏览器渲染失败");
  });

  it("fetch 缓存：同一 URL 第二次命中（direct）", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r1 = await svc.fetch({ url: `${targetBase}/normal` });
    expect(r1.ok).toBe(true);
    const r2 = await svc.fetch({ url: `${targetBase}/normal` });
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r2.text).toBe(r1.text);
  });

  it("错误码前缀：[FETCH_NOT_HTML]", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r = await svc.fetch({ url: "http://127.0.0.1:1/whatever" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBeDefined();
      expect(r.text.startsWith("[")).toBe(true);
    }
  });
});

describe("fetch JS 渲染判定（render 参数）", () => {
  const renderedLong =
    "<html><head><title>渲染页</title></head><body><article><h1>渲染正文</h1><p>" +
    "浏览器渲染内容".repeat(30) +
    "</p></article></body></html>";

  it("auto：大体积 SPA 空壳升级 playwright（旧版按 HTML 体积会漏）", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const browser = makeFakeBrowser(renderedLong);
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const before = fsCalled;
    const r = await svc.fetch({ url: `${targetBase}/spa-big` });
    expect(r.ok).toBe(true);
    expect(browser.calls).toBe(1);
    expect(fsCalled).toBe(before);
    if (r.ok) {
      expect(r.text).toContain("渲染正文");
      expect(r.text).toContain("浏览器渲染获取");
    }
  });

  it("auto：短静态页有正文节点，不升级", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const browser = makeFakeBrowser(renderedLong);
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const r = await svc.fetch({ url: `${targetBase}/short-static` });
    expect(r.ok).toBe(true);
    expect(browser.calls).toBe(0);
    if (r.ok) expect(r.text).toContain("一句正文");
  });

  it("render=never：不渲染，空正文返回 FETCH_RENDER_FAIL", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const browser = makeFakeBrowser(renderedLong);
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const r = await svc.fetch({ url: `${targetBase}/spa-big`, render: "never" });
    expect(r.ok).toBe(false);
    expect(browser.calls).toBe(0);
    if (!r.ok) {
      expect(r.code).toBe("FETCH_RENDER_FAIL");
      expect(r.text).toContain("render=never");
    }
  });

  it("render=always：正常页也强制渲染", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const browser = makeFakeBrowser(renderedLong);
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const r = await svc.fetch({ url: `${targetBase}/normal`, render: "always" });
    expect(r.ok).toBe(true);
    expect(browser.calls).toBe(1);
    if (r.ok) {
      expect(r.text).toContain("渲染正文");
      expect(r.text).toContain("浏览器渲染获取");
    }
  });

  it("误判兜底：渲染结果更短时保留 direct 正文", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const browser = makeFakeBrowser("<html><head><title>渲染</title></head><body><p>短</p></body></html>");
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const r = await svc.fetch({ url: `${targetBase}/normal`, render: "always" });
    expect(r.ok).toBe(true);
    expect(browser.calls).toBe(1);
    if (r.ok) {
      expect(r.text).toContain("正常内容");
      expect(r.text).not.toContain("浏览器渲染获取");
    }
  });

  it("playwright 失败 → FlareSolverr 兜底", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const browser = makeFakeBrowser(renderedLong, "boom");
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const before = fsCalled;
    const r = await svc.fetch({ url: `${targetBase}/spa-big` });
    expect(r.ok).toBe(true);
    expect(fsCalled).toBe(before + 1);
    if (r.ok) {
      expect(r.text).toContain("渲染正文");
      expect(r.text).toContain("浏览器渲染获取");
    }
  });

  it("auto + fallback_on_empty=false：不渲染，空正文报错", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase, fallback_on_empty: false } });
    const browser = makeFakeBrowser(renderedLong);
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const r = await svc.fetch({ url: `${targetBase}/spa-big` });
    expect(r.ok).toBe(false);
    expect(browser.calls).toBe(0);
    if (!r.ok) {
      expect(r.code).toBe("FETCH_RENDER_FAIL");
      expect(r.text).toContain("fallback_on_empty=false");
    }
  });

  it("仅图片的页面在 render=never 下仍返回 direct，不误报空", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const browser = makeFakeBrowser(renderedLong);
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const r = await svc.fetch({ url: `${targetBase}/image-shell`, render: "never" });
    expect(r.ok).toBe(true);
    expect(browser.calls).toBe(0);
    if (r.ok) {
      expect(r.text).toContain("https://example.com/pic.png");
      expect(r.text).toContain("render=auto");
    }
  });

  it("data: URI 图片落盘并换成 /files 链接", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-inline-"));
    try {
      const store = new FetchStore(dir, 60_000, 10 * 1024 * 1024);
      const svc = createFetchService(makeConfig(), silentLogger, undefined, store);
      const r = await svc.fetch({ url: `${targetBase}/data-image` });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const match = /\/files\/([0-9a-f]{64})/.exec(r.text);
        expect(match).toBeTruthy();
        expect(store.get(match![1]!)).toBeTruthy();
        expect(r.text).not.toContain("data:image");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("URL 凭据脱敏", () => {
  const CRED_URL = "https://user:sekret@example.com/";

  function makeCapturingLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const logger = {
      debug: (m: string) => lines.push(m),
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      close: () => {},
    } as unknown as Logger;
    return { logger, lines };
  }

  it("带凭据的 URL → FETCH_INVALID_URL，文本不含密码", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r = await svc.fetch({ url: CRED_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FETCH_INVALID_URL");
      expect(r.text).toContain("URL 不允许包含用户名或密码");
      expect(r.text).not.toContain("sekret");
    }
  });

  it("带凭据的 URL 不升级 FlareSolverr / 浏览器", async () => {
    const cfg = makeConfig({ flaresolverr: { url: fsBase } });
    const browser = makeFakeBrowser("<html><body><p>不应该出现</p></body></html>");
    const svc = createFetchService(cfg, silentLogger, browser.pool);
    const before = fsCalled;
    const r = await svc.fetch({ url: CRED_URL, render: "always" });
    expect(r.ok).toBe(false);
    expect(fsCalled).toBe(before);
    expect(browser.calls).toBe(0);
  });

  it("日志里不出现密码", async () => {
    const { logger, lines } = makeCapturingLogger();
    const svc = createFetchService(makeConfig(), logger);
    await svc.fetch({ url: CRED_URL });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("sekret");
    expect(lines.join("\n")).toContain("example.com/");
  });

  it("redactUrl 清空 username/password，解析失败原样返回", () => {
    expect(redactUrl("https://user:sekret@example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(redactUrl("https://user@example.com/")).toBe("https://example.com/");
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("输出上限 capOutput / max_chars 硬上限", () => {
  it("limit 未定义 → 原样返回", () => {
    expect(capOutput("abc", undefined)).toBe("abc");
  });

  it("短文本 → 原样返回", () => {
    expect(capOutput("abc", 10)).toBe("abc");
    expect(capOutput("abcde", 5)).toBe("abcde");
  });

  it("超长文本 → 长度不超过 limit 且带截断标记", () => {
    const out = capOutput("x".repeat(100), 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("…(内容已截断)")).toBe(true);
    expect(out.startsWith("xxxx")).toBe(true);
  });

  it("limit=10 → 长度 ≤ 10（放不下标记时直接切）", () => {
    const out = capOutput("y".repeat(100), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).not.toContain("内容已截断");
  });

  it("limit=1 → 长度为 1（不返回空字符串）", () => {
    expect(capOutput("z".repeat(100), 1).length).toBe(1);
  });

  it("PDF + max_chars=10 → 最终长度 ≤ 10（含标题）", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r = await svc.fetch({ url: `${targetBase}/pdf`, maxChars: 10 });
    expect(r.ok).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(10);
  });

  it("HTML 有 <title> + max_chars=20 → 最终长度 ≤ 20（标题也在预算内）", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r = await svc.fetch({ url: `${targetBase}/normal`, maxChars: 20 });
    expect(r.ok).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20);
  });
});
