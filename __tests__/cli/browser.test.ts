import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BrowserPool } from "../../src/browser/pool.js";
import { BrowserTools, MAX_SELECTOR_CHARS, SELECTOR_TIMEOUT_MS } from "../../src/browser/tools.js";
import type { Reporter } from "../../src/cli/output.js";
import {
  browserStatus,
  installBrowser,
  playwrightCacheDir,
} from "../../src/cli/deps/browser.js";
import type { StreamRunner } from "../../src/cli/deps/stream.js";
import { mcpSessionContext } from "../../src/utils/session-context.js";
import { browserToolDeps, makeSettings } from "../helpers/settings.js";

const tempDirs: string[] = [];

function tempDir(prefix = "asg-browser-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function reporter(): Reporter {
  return {
    mode: "jsonl",
    event: vi.fn(),
    info: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
  } as unknown as Reporter;
}

function makeInstallRoot(): { root: string; cli: string } {
  const root = tempDir("asg-browser-root-");
  const release = path.join(root, "release");
  const cli = path.join(release, "node_modules", "playwright", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "", "utf8");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "current.json"),
    `${JSON.stringify({ dir: release })}\n`,
    "utf8",
  );
  return { root, cli };
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Playwright 缓存目录", () => {
  it("按平台返回约定路径", () => {
    const home = "/home/tester";
    expect(playwrightCacheDir({ platform: "linux", home })).toBe(
      path.join(home, ".cache", "ms-playwright"),
    );
    expect(playwrightCacheDir({ platform: "darwin", home })).toBe(
      path.join(home, "Library", "Caches", "ms-playwright"),
    );
    expect(
      playwrightCacheDir({
        platform: "win32",
        home: "C:\\Users\\tester",
        env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      }),
    ).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "ms-playwright"));
    expect(
      playwrightCacheDir({
        platform: "win32",
        home: "C:\\Users\\tester",
        env: {},
      }),
    ).toBe(path.join("C:\\Users\\tester", "AppData", "Local", "ms-playwright"));
  });

  it("只按目录前缀识别 headless shell 与完整 chromium", () => {
    const linuxShell = tempDir();
    fs.mkdirSync(path.join(linuxShell, ".cache", "ms-playwright", "chromium_headless_shell-1200"), {
      recursive: true,
    });
    expect(browserStatus({ platform: "linux", home: linuxShell })).toMatchObject({
      headless_shell: true,
      chromium: false,
      path: path.join(linuxShell, ".cache", "ms-playwright"),
    });

    const linuxFull = tempDir();
    fs.mkdirSync(path.join(linuxFull, ".cache", "ms-playwright", "chromium-1200"), {
      recursive: true,
    });
    expect(browserStatus({ platform: "linux", home: linuxFull })).toMatchObject({
      headless_shell: false,
      chromium: true,
    });

    const empty = tempDir();
    expect(browserStatus({ platform: "linux", home: empty })).toMatchObject({
      headless_shell: false,
      chromium: false,
    });
  });
});

describe("browser install 参数", () => {
  it("默认只装 headless shell，--full 装完整 chromium", async () => {
    const { root, cli } = makeInstallRoot();
    const calls: string[][] = [];
    const runner: StreamRunner = async (_command, args) => {
      calls.push(args);
      return { code: 0, signal: null };
    };

    await installBrowser({ root, full: false, reporter: reporter(), runner });
    await installBrowser({ root, full: true, reporter: reporter(), runner });

    expect(calls[0]).toEqual([cli, "install", "chromium", "--only-shell"]);
    expect(calls[1]).toEqual([cli, "install", "chromium"]);
  });

  it("安装失败抛 BROWSER_NOT_INSTALLED（退出码 1）", async () => {
    const { root } = makeInstallRoot();
    const runner: StreamRunner = async () => ({ code: 1, signal: null });

    await expect(
      installBrowser({ root, full: false, reporter: reporter(), runner }),
    ).rejects.toMatchObject({ code: "BROWSER_NOT_INSTALLED", exitCode: 1 });
  });

  it("release 内缺少 Playwright CLI 时同样报 BROWSER_NOT_INSTALLED", async () => {
    const root = tempDir("asg-browser-nocli-");
    const release = path.join(root, "release");
    fs.mkdirSync(release, { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "current.json"),
      `${JSON.stringify({ dir: release })}\n`,
      "utf8",
    );

    const runner: StreamRunner = async () => ({ code: 0, signal: null });
    await expect(
      installBrowser({ root, full: false, reporter: reporter(), runner }),
    ).rejects.toMatchObject({ code: "BROWSER_NOT_INSTALLED", exitCode: 1 });
  });
});

type Recorded = { method: string; args: unknown[] };

/** 假 page：只记录 locator/动作调用，不启动 playwright。 */
function makeFakePage(opts: { snapshotText?: string; failWith?: Error } = {}): {
  page: Page;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const locator = (selector: string) => {
    calls.push({ method: "locator", args: [selector] });
    const handle = {
      first: () => handle,
      click: async (options?: unknown) => {
        calls.push({ method: "click", args: [options] });
        if (opts.failWith) throw opts.failWith;
      },
      fill: async (text: string, options?: unknown) => {
        calls.push({ method: "fill", args: [text, options] });
        if (opts.failWith) throw opts.failWith;
      },
      waitFor: async (options?: unknown) => {
        calls.push({ method: "waitFor", args: [options] });
        if (opts.failWith) throw opts.failWith;
      },
      ariaSnapshot: async () => {
        calls.push({ method: "ariaSnapshot", args: [] });
        return opts.snapshotText ?? "snapshot";
      },
    };
    return handle;
  };
  return { page: { locator } as unknown as Page, calls };
}

function makeTools(page: Page, timeoutMs = 30000) {
  const pool = { acquireSession: async () => ({ page }) } as unknown as BrowserPool;
  const settings = makeSettings({ browser: { timeout_ms: timeoutMs } });
  return { tools: new BrowserTools(pool, browserToolDeps(settings)) };
}

describe("BrowserTools 选择器超时与长度上限", () => {
  it("超长选择器立即报错且不调用 locator", async () => {
    const { page, calls } = makeFakePage();
    const { tools } = makeTools(page);
    const long = `#${"a".repeat(MAX_SELECTOR_CHARS)}`;

    const results = [
      await tools.click(long),
      await tools.type(long, "x"),
      await tools.snapshot(long),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe(`选择器过长（上限 ${MAX_SELECTOR_CHARS} 字符）`);
    }
    expect(calls).toHaveLength(0);
  });

  it("click / type 传入的 timeout 不超过 SELECTOR_TIMEOUT_MS", async () => {
    expect(SELECTOR_TIMEOUT_MS).toBeLessThanOrEqual(8000);
    const { page, calls } = makeFakePage();
    const { tools } = makeTools(page);

    await tools.click("#btn");
    await tools.type("#input", "hello");

    const clickOptions = calls.find((c) => c.method === "click")!.args[0] as { timeout: number };
    const fillOptions = calls.find((c) => c.method === "fill")!.args[1] as { timeout: number };
    expect(clickOptions.timeout).toBe(SELECTOR_TIMEOUT_MS);
    expect(fillOptions.timeout).toBe(SELECTOR_TIMEOUT_MS);
    expect(clickOptions.timeout).toBeLessThanOrEqual(8000);
  });

  it("全局超时更小时取全局值", async () => {
    const { page, calls } = makeFakePage();
    const { tools } = makeTools(page, 3000);

    await tools.click("#btn");

    const clickOptions = calls.find((c) => c.method === "click")!.args[0] as { timeout: number };
    expect(clickOptions.timeout).toBe(3000);
  });

  it("snapshot(target) 用受限超时等待选择器", async () => {
    const { page, calls } = makeFakePage();
    const { tools } = makeTools(page);

    const r = await tools.snapshot("#result");
    expect(r.ok).toBe(true);
    const waitOptions = calls.find((c) => c.method === "waitFor")!.args[0] as { timeout: number };
    expect(waitOptions.timeout).toBe(SELECTOR_TIMEOUT_MS);
  });

  it("选择器超时时返回 playwright 原文错误", async () => {
    const timeoutErr = Object.assign(new Error("locator.click: Timeout 8000ms exceeded."), {
      name: "TimeoutError",
    });
    const { page } = makeFakePage({ failWith: timeoutErr });
    const { tools } = makeTools(page);

    const r = await tools.click("#btn");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("locator.click: Timeout 8000ms exceeded.");
  });
});

type Interval = { start: number; end: number };

/**
 * 记录每次操作起止时间的假 page（navigate 会 goto + snapshot）。
 * - intervals：goto 区间
 * - evalIntervals：evaluate 区间（scroll 用）
 * - ariaIntervals：ariaSnapshot 区间（find / snapshot 用）
 * - failGotos：前 N 次 goto 抛错，用于验证失败不卡死串行链
 */
function makeTimedPage(
  opts: {
    delayMs?: number;
    failGotos?: number;
    evaluateDelayMs?: number;
    ariaDelayMs?: number;
  } = {},
): { page: Page; intervals: Interval[]; evalIntervals: Interval[]; ariaIntervals: Interval[] } {
  const delayMs = opts.delayMs ?? 50;
  const failGotos = opts.failGotos ?? 0;
  const evaluateDelayMs = opts.evaluateDelayMs ?? 0;
  const ariaDelayMs = opts.ariaDelayMs ?? 0;
  const intervals: Interval[] = [];
  const evalIntervals: Interval[] = [];
  const ariaIntervals: Interval[] = [];
  let gotoCalls = 0;

  const record = async (bucket: Interval[], ms: number): Promise<void> => {
    const start = Date.now();
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    bucket.push({ start, end: Date.now() });
  };

  const page = {
    async goto() {
      const index = gotoCalls++;
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      intervals.push({ start, end: Date.now() });
      if (index < failGotos) throw new Error("page.goto 失败");
      return null;
    },
    async evaluate() {
      await record(evalIntervals, evaluateDelayMs);
      return null;
    },
    url: () => "about:blank",
    locator: () => {
      const handle = {
        first: () => handle,
        ariaSnapshot: async () => {
          await record(ariaIntervals, ariaDelayMs);
          return "snapshot";
        },
      };
      return handle;
    },
  };
  return { page: page as unknown as Page, intervals, evalIntervals, ariaIntervals };
}

/** navigate 需要 pool.enabled，且测试不走真实 DNS：关闭 SSRF 私网校验。 */
function makeTimedTools(page: Page) {
  const pool = {
    enabled: true,
    acquireSession: async () => ({ page }),
  } as unknown as BrowserPool;
  const settings = makeSettings({
    browser: { timeout_ms: 5000 },
    fetch: { block_private_ips: false },
  });
  return new BrowserTools(pool, browserToolDeps(settings));
}

describe("BrowserTools 按会话串行化", () => {
  it("同一 session 的并发 navigate 串行执行", async () => {
    const { page, intervals } = makeTimedPage();
    const tools = makeTimedTools(page);

    const results = await mcpSessionContext.run("s1", () =>
      Promise.all([
        tools.navigate("https://example.com/a"),
        tools.navigate("https://example.com/b"),
      ]),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(intervals).toHaveLength(2);
    // 第二段必须在第一段结束之后才开始
    expect(intervals[1].start).toBeGreaterThanOrEqual(intervals[0].end);
  });

  it("不同 session 的并发 navigate 并行执行", async () => {
    const { page, intervals } = makeTimedPage();
    const tools = makeTimedTools(page);

    await Promise.all([
      mcpSessionContext.run("s1", () => tools.navigate("https://example.com/a")),
      mcpSessionContext.run("s2", () => tools.navigate("https://example.com/b")),
    ]);

    expect(intervals).toHaveLength(2);
    // 两段区间有重叠（互不等待）
    const [x, y] = intervals;
    expect(x.start).toBeLessThan(y.end);
    expect(y.start).toBeLessThan(x.end);
  });

  it("一次 navigate 抛错后，同 session 的后续 navigate 仍能执行", async () => {
    const { page, intervals } = makeTimedPage({ failGotos: 1 });
    const tools = makeTimedTools(page);

    const [failed, succeeded] = await mcpSessionContext.run("s1", () =>
      Promise.all([
        tools.navigate("https://example.com/fail"),
        tools.navigate("https://example.com/ok"),
      ]),
    );

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("page.goto 失败");
    expect(succeeded.ok).toBe(true);
    expect(intervals).toHaveLength(2);
    // 失败也推进了链：第二次仍在第一次结束之后开始
    expect(intervals[1].start).toBeGreaterThanOrEqual(intervals[0].end);
  });

  it("同一 session 的并发 scroll 串行执行", async () => {
    const { page, evalIntervals } = makeTimedPage({ evaluateDelayMs: 50 });
    const tools = makeTimedTools(page);

    const results = await mcpSessionContext.run("s1", () =>
      Promise.all([tools.scroll("down"), tools.scroll("up")]),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(evalIntervals).toHaveLength(2);
    // 第二次滚动必须在第一次滚动结束后才开始（不会互相覆盖滚动位置）
    expect(evalIntervals[1].start).toBeGreaterThanOrEqual(evalIntervals[0].end);
  });

  it("同一 session 的并发 find 串行执行", async () => {
    const { page, ariaIntervals } = makeTimedPage({ ariaDelayMs: 50 });
    const tools = makeTimedTools(page);

    const results = await mcpSessionContext.run("s1", () =>
      Promise.all([tools.find("snap"), tools.find("shot")]),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(ariaIntervals).toHaveLength(2);
    // 两次 ariaSnapshot 读取不重叠
    expect(ariaIntervals[1].start).toBeGreaterThanOrEqual(ariaIntervals[0].end);
  });
});
