import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFlareSolverrClient } from "../src/fetch/flaresolverr.js";
import type { FlareSolverrSettingsDeps } from "../src/fetch/flaresolverr.js";
import { deepMerge, flareSolverrDeps, makeSettings, type DeepPartial } from "./helpers/settings.js";
import type { Settings } from "../src/settings/index.js";
import { Semaphore } from "../src/utils/semaphore.js";

function makeConfig(overrides: DeepPartial<Settings> = {}): FlareSolverrSettingsDeps {
  const base: DeepPartial<Settings> = { fetch: { block_private_ips: false } };
  return flareSolverrDeps(makeSettings(deepMerge(base, overrides)));
}

interface MockBehavior {
  status: "ok" | "error";
  response?: string;
  message?: string;
  returnOnlyCookies?: boolean;
}

let server: ReturnType<typeof createHttpServer>;
let base = "";
let receivedBody: unknown = null;

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const behavior = (server as unknown as { behavior?: MockBehavior }).behavior ?? { status: "ok", response: "<html><body>rendered</body></html>" };
      if (behavior.status === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            solution: {
              url: "https://target.example/",
              status: 200,
              response: behavior.returnOnlyCookies ? undefined : (behavior.response ?? "<html><body>rendered</body></html>"),
              cookies: [{ name: "cf_clearance", value: "abc" }],
              userAgent: "Mozilla/5.0",
            },
          }),
        );
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: behavior.message ?? "failed" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function setBehavior(b: MockBehavior): void {
  (server as unknown as { behavior: MockBehavior }).behavior = b;
}

describe("createFlareSolverrClient", () => {
  it("请求体：request.get + returnOnlyCookies=false", async () => {
    const cfg = makeConfig({ flaresolverr: { url: base } });
    const client = createFlareSolverrClient(cfg);
    setBehavior({ status: "ok", response: "<html><body>r</body></html>" });
    await client.requestGet("https://target.example/");
    expect(receivedBody).toMatchObject({
      cmd: "request.get",
      url: "https://target.example/",
      returnOnlyCookies: false,
    });
  });

  it("成功返回渲染 HTML", async () => {
    const cfg = makeConfig({ flaresolverr: { url: base } });
    const client = createFlareSolverrClient(cfg);
    setBehavior({ status: "ok", response: "<html><body>RENDERED</body></html>" });
    const r = await client.requestGet("https://target.example/");
    expect(r.ok).toBe(true);
    expect(r.renderedHtml).toContain("RENDERED");
    expect(r.finalUrl).toBe("https://target.example/");
  });

  it("error 状态返回 not_ok", async () => {
    const cfg = makeConfig({ flaresolverr: { url: base } });
    const client = createFlareSolverrClient(cfg);
    setBehavior({ status: "error", message: "challenge failed" });
    const r = await client.requestGet("https://target.example/");
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("not_ok");
  });

  it("FlareSolverr 不可达返回 network", async () => {
    const cfg = makeConfig({ flaresolverr: { url: "http://127.0.0.1:1" } });
    const client = createFlareSolverrClient(cfg);
    const r = await client.requestGet("https://target.example/");
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("network");
  });

  it("SSRF：内网 URL 被拦截（不发请求到 FlareSolverr）", async () => {
    const cfg = makeConfig({ flaresolverr: { url: base }, fetch: { block_private_ips: true } });
    const client = createFlareSolverrClient(cfg);
    const r = await client.requestGet("http://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("blocked");
  });

  it("SSRF：非 http/https 协议被拦截", async () => {
    const cfg = makeConfig({ flaresolverr: { url: base }, fetch: { block_private_ips: true } });
    const client = createFlareSolverrClient(cfg);
    const r = await client.requestGet("file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("blocked");
  });

  it("fetchBlockPrivateIps=false 时内网 URL 放行（仅协议检查）", async () => {
    const cfg = makeConfig({ flaresolverr: { url: base }, fetch: { block_private_ips: false } });
    const client = createFlareSolverrClient(cfg);
    setBehavior({ status: "ok", response: "<html><body>ok</body></html>" });
    const r = await client.requestGet("http://127.0.0.1:8080/");
    expect(r.ok).toBe(true);
  });

  it("共享信号量：两个客户端（模拟两个会话）并发不超过 max_concurrent", async () => {
    let active = 0;
    let maxActive = 0;
    const mock = createHttpServer((req, res) => {
      req.resume();
      req.on("end", () => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active--;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              solution: { url: "https://target.example/", status: 200, response: "<html><body>ok</body></html>" },
            }),
          );
        }, 30);
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    const mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    try {
      const cfg = makeConfig({ flaresolverr: { url: mockUrl, max_concurrent: 2 } });
      // 进程级共享一个 sem（等价于 server.ts 的 getFlareSolverrClient）
      const sem = new Semaphore(2);
      const clientA = createFlareSolverrClient(cfg, sem);
      const clientB = createFlareSolverrClient(cfg, sem);
      await Promise.all([
        clientA.requestGet("https://target.example/1"),
        clientA.requestGet("https://target.example/2"),
        clientB.requestGet("https://target.example/3"),
        clientB.requestGet("https://target.example/4"),
      ]);
      // 若各自 new Semaphore，这里会是 4
      expect(maxActive).toBe(2);
    } finally {
      await new Promise<void>((r) => mock.close(() => r()));
    }
  });
});
