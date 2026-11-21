import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../src/logger.js";
import { closeGatewayRuntime, createServer } from "../src/server.js";
import type { Settings } from "../src/settings/index.js";
import { deepMerge, makeSecrets, makeSettings, type DeepPartial } from "./helpers/settings.js";

/** 回归：hosts 过期时的下载必须发生在后台，不能阻塞 createServer（慢网会拖垮 MCP initialize）。 */
const DIR = mkdtempSync(join(tmpdir(), "gw-adlist-async-"));
const HOSTS = join(DIR, "hosts");

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

function makeConfig(overrides: DeepPartial<Settings> = {}): Settings {
  const base: DeepPartial<Settings> = {
    ad_filter: {
      enabled: true,
      level: "ads",
      hosts_file: HOSTS,
      auto_update: true,
      auto_update_interval_ms: 86400000,
    },
    fetch: {
      download_dir: DIR,
      download_ttl_ms: 604800000,
      download_max_total_bytes: 4294967296,
      files_route: false,
    },
  };
  return makeSettings(deepMerge(base, overrides));
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待超时");
}

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeGatewayRuntime();
  rmSync(DIR, { recursive: true, force: true });
});

describe("adlist 后台刷新", () => {
  it("hosts 过期时 createServer 不等待下载", async () => {
    writeFileSync(HOSTS, "0.0.0.0 old.example.com\n", "utf-8");
    const stale = new Date(Date.now() - 3 * 86400000);
    utimesSync(HOSTS, stale, stale);

    let fetchCalled = false;
    let fetchSettled = false;
    let resolveFetch: ((res: Response) => void) | null = null;
    vi.stubGlobal("fetch", () => {
      fetchCalled = true;
      return new Promise<Response>((resolve) => {
        resolveFetch = (res) => {
          fetchSettled = true;
          resolve(res);
        };
      });
    });

    const server = await createServer(makeConfig(), makeSecrets(), silentLogger);
    expect(server).toBeTruthy();
    expect(fetchCalled).toBe(true);
    // 关键断言：下载还悬着，createServer 已经返回
    expect(fetchSettled).toBe(false);

    resolveFetch!(new Response("0.0.0.0 new.example.com\n", { status: 200 }));
    await waitFor(() => readFileSync(HOSTS, "utf-8").includes("new.example.com"));
  });

  it("auto_update 关闭时完全不发起下载", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await createServer(
      makeConfig({ ad_filter: { auto_update: false } }),
      makeSecrets(),
      silentLogger,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
