import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { getFetchStore, startHttpServer } from "../src/server.js";
import { createServer } from "../src/server.js";

/** 产物落盘目录：测试统一用临时目录，避免污染仓库 data/。 */
const DOWNLOAD_DIR = mkdtempSync(join(tmpdir(), "gw-files-"));

afterAll(() => {
  rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
});

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: undefined,
    logLevel: "info",
    logFile: undefined,
    searxngUrl: "http://127.0.0.1:1",
    searxngTimeoutMs: 3000,
    flaresolverrUrl: "http://127.0.0.1:1",
    flaresolverrEnabled: true,
    flaresolverrTimeoutMs: 5000,
    flaresolverrMaxConcurrent: 2,
    flaresolverrTriggerStatus: [403, 405, 429],
    flaresolverrFallbackOnEmpty: true,
    searchMaxResults: 10,
    searchMaxResultsCap: 50,
    searchMaxResultChars: 500,
    searchCacheTtlMs: 300000,
    searchCacheMaxEntries: 200,
    searchMaxConcurrent: 2,
    adFilterEnabled: false,
    adFilterLevel: "off",
    adFilterExtraDomains: [],
    adFilterHostsFile: "data/adblock/hosts",
    adFilterAllowlist: [],
    adFilterAutoUpdate: false,
    adFilterAutoUpdateIntervalMs: 86400000,
    fetchMaxDownloadBytes: 1073741824,
    fetchDownloadDir: DOWNLOAD_DIR,
    fetchDownloadTtlMs: 604800000,
    fetchDownloadMaxTotalBytes: 4294967296,
    fetchFilesRoute: true,
    ...overrides,
  };
}

async function mcpRequest(base: string, body: unknown, opts: { token?: string; sessionId?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.sessionId) headers["Mcp-Session-Id"] = opts.sessionId;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("MCP HTTP server", () => {
  let base = "";
  let closeFn: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const cfg = makeConfig();
    const http = await startHttpServer({ config: cfg, logger: silentLogger }, createServer);
    closeFn = http.close;
    const url = new URL(http.url);
    base = `http://127.0.0.1:${url.port}`;
  });

  afterAll(async () => {
    await closeFn?.();
  });

  it("无 token 时 initialize 握手成功并返回 serverInfo", async () => {
    const { status, text } = await mcpRequest(base, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(status).toBe(200);
    expect(text).toContain("agent-search-gateway");
    expect(text).toContain("tools");
  });

  it("initialize 后带 session 可调 tools/list", async () => {
    // initialize 拿 session id
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const { status, text } = await mcpRequest(base, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { sessionId: sessionId! });
    expect(status).toBe(200);
    expect(text).toContain("health");
  });

  it("tools/call health 返回后端状态", async () => {
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id")!;
    const { text } = await mcpRequest(
      base,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "health", arguments: {} } },
      { sessionId },
    );
    expect(text).toContain("searxng");
    expect(text).toContain("flaresolverr");
  });

  it("tools/call search 的 num_results 超过旧上限 20 不再被参数校验拒绝", async () => {
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id")!;
    const { text } = await mcpRequest(
      base,
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search", arguments: { query: "x", num_results: 999 } } },
      { sessionId },
    );
    // 参数通过校验并走到服务层：searxng 不可达 → 返回「搜索失败」而非参数校验错误
    expect(text).toContain("搜索失败");
  });

  it("GET /files/<id> 返回产物，未知 id 404", async () => {
    const store = getFetchStore(makeConfig(), silentLogger);
    const f = store.put(Buffer.from("file-body"), {
      contentType: "text/plain",
      sourceUrl: "https://example.com/a.txt",
    });

    const ok = await fetch(`${base}/files/${f.id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain");
    expect(await ok.text()).toBe("file-body");

    const miss = await fetch(`${base}/files/${"0".repeat(64)}`);
    expect(miss.status).toBe(404);

    const traversal = await fetch(`${base}/files/..%2F..%2Fetc%2Fpasswd`);
    expect(traversal.status).toBe(404);
  });
});

describe("token 认证", () => {
  let base = "";
  let closeFn: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const cfg = makeConfig({ token: "secret-token" });
    const http = await startHttpServer({ config: cfg, logger: silentLogger }, createServer);
    closeFn = http.close;
    const url = new URL(http.url);
    base = `http://127.0.0.1:${url.port}`;
  });

  afterAll(async () => {
    await closeFn?.();
  });

  it("无 token 返回 401", async () => {
    const { status } = await mcpRequest(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(status).toBe(401);
  });

  it("错误 token 返回 401", async () => {
    const { status } = await mcpRequest(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: "wrong" });
    expect(status).toBe(401);
  });

  it("正确 token 通过认证", async () => {
    const { status } = await mcpRequest(
      base,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { token: "secret-token" },
    );
    expect(status).toBe(200);
  });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** initialize 并返回会话 id（响应体读空，避免连接悬挂）。 */
async function initSession(base: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  await res.text();
  return sid!;
}

/** 打开 GET /mcp 的 standalone SSE 流（保持不读 body，模拟客户端挂长连接）。 */
async function openSse(base: string, sessionId: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "GET",
    headers: { Accept: "text/event-stream", "Mcp-Session-Id": sessionId },
    signal,
  });
}

describe("session 空闲清扫", () => {
  let base = "";
  let closeFn: (() => Promise<void>) | undefined;

  // 短 TTL / 短 tick：不用真等 1 小时
  const TTL_MS = 250;
  const SWEEP_MS = 20;

  beforeAll(async () => {
    const http = await startHttpServer(
      {
        config: makeConfig(),
        logger: silentLogger,
        sessionIdleTtlMs: TTL_MS,
        sessionSweepIntervalMs: SWEEP_MS,
      },
      createServer,
    );
    closeFn = http.close;
    base = `http://127.0.0.1:${new URL(http.url).port}`;
  });

  afterAll(async () => {
    await closeFn?.();
  });

  it("GET /mcp 的 SSE 流开着时，即使超过 TTL 也不被清扫", async () => {
    const sid = await initSession(base);
    const ac = new AbortController();
    const sse = await openSse(base, sid, ac.signal);
    expect(sse.status).toBe(200);

    // > 3×TTL，修复前这里会话已经被扫掉
    await sleep(TTL_MS * 3);

    const { status } = await mcpRequest(base, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId: sid });
    expect(status).toBe(200);

    ac.abort();
    await sse.body?.cancel().catch(() => {});
  });

  it("没有 SSE 流的空闲会话仍会被清扫", async () => {
    const sid = await initSession(base);
    await sleep(TTL_MS * 3);

    const { status } = await mcpRequest(base, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { sessionId: sid });
    expect(status).toBe(404);
  });

  it("SSE 流关闭后 TTL 重新计时", async () => {
    const sid = await initSession(base);
    const ac = new AbortController();
    const sse = await openSse(base, sid, ac.signal);
    expect(sse.status).toBe(200);

    // 流开着远超 TTL
    await sleep(TTL_MS * 3);
    ac.abort();
    await sse.body?.cancel().catch(() => {});
    await sleep(TTL_MS / 2);

    // 关流后重新获得一个完整 TTL
    const ok = await mcpRequest(base, { jsonrpc: "2.0", id: 4, method: "tools/list" }, { sessionId: sid });
    expect(ok.status).toBe(200);

    // 再超过 TTL（且无新活动）才被清扫
    await sleep(TTL_MS * 3);
    const gone = await mcpRequest(base, { jsonrpc: "2.0", id: 5, method: "tools/list" }, { sessionId: sid });
    expect(gone.status).toBe(404);
  });

  it("未知 session id 的 GET 返回 404", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream", "Mcp-Session-Id": "not-a-real-session" },
    });
    await res.body?.cancel().catch(() => {});
    expect(res.status).toBe(404);
  });
});
