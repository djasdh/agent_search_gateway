/** Playwright 浏览器缓存检测与安装。
 *
 * 浏览器由 gateway 懒加载，安装/更新后不需要重启服务。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { exists, nodePath, releaseDir } from "../root.js";
import { forwardChildLine, spawnStream, type StreamRunner } from "./plugins.js";

export interface BrowserStatus {
  headless_shell: boolean;
  chromium: boolean;
  path: string;
}

export interface BrowserEnv {
  platform?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Playwright 默认缓存目录（与 Playwright 自身规则一致）。 */
export function playwrightCacheDir(options: BrowserEnv = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();

  if (platform === "win32") {
    const localAppData = (options.env ?? process.env).LOCALAPPDATA;
    const base = localAppData && localAppData.trim() ? localAppData : path.join(home, "AppData", "Local");
    return path.join(base, "ms-playwright");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "ms-playwright");
  }
  return path.join(home, ".cache", "ms-playwright");
}

/** 只查缓存目录：headless shell 与完整 chromium 分别判断。 */
export function browserStatus(options: BrowserEnv = {}): BrowserStatus {
  const dir = playwrightCacheDir(options);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return {
    headless_shell: directories.some((name) => name.startsWith("chromium_headless_shell-")),
    chromium: directories.some((name) => name.startsWith("chromium-")),
    path: dir,
  };
}

export interface BrowserInstallOptions {
  root: string;
  full: boolean;
  reporter: Reporter;
  runner?: StreamRunner;
  env?: BrowserEnv;
}

export interface BrowserInstallResult extends BrowserStatus {
  full: boolean;
}

/** 调用当前 release 自带 Playwright CLI 安装 chromium。 */
export async function installBrowser(options: BrowserInstallOptions): Promise<BrowserInstallResult> {
  const { root, reporter, full } = options;
  const release = releaseDir(root);
  const cli = path.join(release, "node_modules", "playwright", "cli.js");
  if (!exists(cli)) {
    throw new CliError(
      "BROWSER_NOT_INSTALLED",
      EXIT.FAIL,
      `未找到 Playwright CLI：${cli}；请确认完整包包含 node_modules`,
    );
  }

  const args = [cli, "install", "chromium", ...(full ? [] : ["--only-shell"])];
  const runner = options.runner ?? spawnStream;
  const result = await runner(nodePath(root), args, {
    cwd: release,
    env: process.env,
    onLine: (line) => forwardChildLine(reporter, line, "browser"),
  });

  if (result.error || result.code !== 0) {
    const detail = result.error
      ? result.error
      : result.code === null
        ? `信号 ${result.signal ?? "unknown"}`
        : `退出码 ${result.code}`;
    throw new CliError(
      "BROWSER_NOT_INSTALLED",
      EXIT.FAIL,
      `Playwright chromium 安装失败（${detail}）`,
    );
  }

  return { ...browserStatus(options.env), full };
}
