import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Reporter } from "../../src/cli/output.js";
import {
  browserStatus,
  installBrowser,
  playwrightCacheDir,
} from "../../src/cli/deps/browser.js";
import type { StreamRunner } from "../../src/cli/deps/plugins.js";

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
