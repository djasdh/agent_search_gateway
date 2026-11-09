import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserPool } from "../src/browser/pool.js";
import { createFetchService } from "../src/fetch/service.js";
import type { Settings } from "../src/settings/index.js";
import { browserPoolDeps, deepMerge, fetchServiceDeps, makeSettings, type DeepPartial } from "./helpers/settings.js";
import type { Logger } from "../src/logger.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

function makeConfig(overrides: DeepPartial<Settings> = {}): Settings {
  const base: DeepPartial<Settings> = {
    fetch: { timeout_ms: 3000, max_bytes: 65536, block_private_ips: false },
    browser: { timeout_ms: 15000 },
    flaresolverr: { url: "http://127.0.0.1:1", timeout_ms: 2000 },
  };
  return makeSettings(deepMerge(base, overrides));
}

let server: ReturnType<typeof createHttpServer>;
let base = "";

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/blocked403") {
      // 403 + 完整 HTML 正文：direct 因 403 失败，playwright 渲染能拿到 body
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>SPA 渲染页</title></head><body><h1>渲染正文</h1><p>JS 动态内容</p></body></html>");
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>SPA 页</title></head><body><h1>渲染正文</h1><p>JS 动态内容</p></body></html>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("fetch 路由③ playwright 兜底", () => {
  it("403 → FlareSolverr 失败 → playwright 渲染成功", async () => {
    const settings = makeConfig();
    const pool = new BrowserPool(browserPoolDeps(settings), silentLogger);
    try {
      const svc = createFetchService(fetchServiceDeps(settings), silentLogger, pool);
      const r = await svc.fetch({ url: `${base}/blocked403` });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.text).toContain("渲染正文");
        expect(r.text).toContain("浏览器渲染");
      }
    } finally {
      await pool.closeAll();
    }
  });
});
