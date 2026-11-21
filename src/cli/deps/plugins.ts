/** 外部后端（插件）的列表、安装与卸载。
 *
 * 后端身份完全由已安装插件的 manifest 决定（`asg-extension.json → backends`），
 * 核心不再内置任何平台名/旧安装名。`asg plugins` 只是兼容 facade：
 *
 * 1. 先在 `data/extensions/*` 的 manifest backends 中按 backend.id / aliases 精确匹配；
 * 2. 未命中时回退到旧的 `scripts/backends/cli.mjs` 子进程，名字原样透传；
 * 3. 都没有则报 PLUGIN_UNKNOWN，并提示用 `asg extensions install` 安装插件。
 *
 * install/remove 成功后保持旧行为：整栈重启。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { exists, nodePath, releaseDir } from "../root.js";
import { restartForConfig } from "../runtime/stack.js";
import { listExtensions, loadInstalledManifest } from "../../extensions/install.js";
import type { ExtensionBackend, ExtensionManifest } from "../../extensions/manifest.js";
import {
  backendInstallDir,
  normalizeBackendState,
  readBackendStates,
} from "../../extensions/paths.js";
import {
  runPluginSetup,
  type RunPluginSetupOptions,
  type RunPluginSetupResult,
} from "../../extensions/setup/runner.js";

/** 兼容 facade 的插件状态。平台/通道字段暂时保留为空字符串。 */
export interface PluginStatus {
  name: string;
  plugin_id?: string;
  backend_id?: string;
  aliases?: string[];
  /** 规范平台 ID；P1 暂不填充。 */
  platform: string;
  /** 通道名；P1 暂不填充。 */
  channel: string;
  /** 完整规范通道 ID；P1 暂不填充。 */
  channel_id: string;
  installed: boolean;
  version?: string;
  enabled: boolean;
  path?: string;
}

export type PluginAction = "install" | "uninstall";

export interface StreamResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export type StreamKind = "stdout" | "stderr";

export interface StreamOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string, stream: StreamKind) => void;
}

/** 注入点：默认用 spawn 流式读取，测试可换成记录参数并回放事件的假实现。 */
export type StreamRunner = (
  command: string,
  args: string[],
  options?: StreamOptions,
) => Promise<StreamResult>;

/** 三个依赖命令共用的流式子进程：逐行回调 stdout/stderr，不做 shell 解析。 */
export const spawnStream: StreamRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, error: messageOf(error) });
      return;
    }

    const buffers: Record<StreamKind, string> = { stdout: "", stderr: "" };
    const feed = (kind: StreamKind, chunk: Buffer | string): void => {
      buffers[kind] += chunk.toString();
      let index = buffers[kind].indexOf("\n");
      while (index !== -1) {
        const line = buffers[kind].slice(0, index).replace(/\r$/, "");
        buffers[kind] = buffers[kind].slice(index + 1);
        if (line.length > 0) options.onLine?.(line, kind);
        index = buffers[kind].indexOf("\n");
      }
    };

    let settled = false;
    const finish = (result: StreamResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => feed("stdout", chunk));
    child.stderr?.on("data", (chunk) => feed("stderr", chunk));
    child.on("error", (error) => finish({ code: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => {
      for (const kind of ["stdout", "stderr"] as const) {
        const rest = buffers[kind].replace(/\r$/, "");
        if (rest.length > 0) options.onLine?.(rest, kind);
      }
      finish({ code, signal });
    });
  });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const data: unknown = JSON.parse(trimmed);
    if (isRecord(data)) return data;
  } catch {
    // 不是合法 JSON，按普通日志处理。
  }
  return null;
}

/** 把子进程输出转发为 event：JSON 行原样透传，其它行包成 log 事件。 */
export function forwardChildLine(reporter: Reporter, line: string, service: string): void {
  if (!line.trim()) return;

  const parsed = parseEventLine(line);
  if (parsed) {
    const { type: _type, ...event } = parsed;
    if (typeof event.event !== "string") event.event = "log";
    if (typeof event.service !== "string") event.service = service;
    if (typeof event.message !== "string" && typeof event.line === "string") {
      event.message = event.line;
    }
    reporter.event(event);
    return;
  }

  reporter.event({ event: "log", service, line, message: line });
}

export function backendsDir(root: string): string {
  return path.join(root, "data", "backends");
}

export {
  backendInstallDir,
  backendStateFile,
  extensionDataDir,
  normalizeBackendState,
  readBackendStates,
} from "../../extensions/paths.js";
export type {
  BackendStateRead,
  PluginBackendState as BackendStateInfo,
} from "../../extensions/paths.js";

interface VersionRecord {
  installed: boolean;
  version?: string;
}

function readVersionRecord(dir: string): VersionRecord {
  const file = path.join(dir, "version.json");
  if (!exists(file)) return { installed: false };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
    return {
      installed: true,
      ...(typeof data.version === "string" ? { version: data.version } : {}),
    };
  } catch {
    // 文件存在但损坏：仍算已安装，只是没有版本号。
    return { installed: true };
  }
}

/**
 * 只读本地文件，离线可用，不触碰网络与服务。
 *
 * 1. 扫描 `data/extensions/*` 的 manifest backends，生成通用 PluginStatus；
 * 2. 再补上 `data/backends/*` 中未被任何 manifest backend（id / aliases / state.path）
 *    覆盖的旧安装。
 */
export function listPlugins(root: string): PluginStatus[] {
  const plugins: PluginStatus[] = [];
  const coveredDirs = new Set<string>();

  for (const extension of listExtensions(root)) {
    const backends = extension.backends ?? [];
    if (backends.length === 0) continue;

    const { states } = readBackendStates(root, extension.id);
    for (const backend of backends) {
      const state = normalizeBackendState(states[backend.id]);
      const backendDir = backendInstallDir(root, extension.id, backend.id);
      const dirInstalled = exists(backendDir);
      const installed = state.installed || dirInstalled;

      coveredDirs.add(backend.id);
      for (const legacy of backend.aliases ?? []) coveredDirs.add(legacy);
      if (state.path) coveredDirs.add(path.basename(state.path));

      const plugin: PluginStatus = {
        name: backend.aliases?.[0] ?? backend.id,
        plugin_id: extension.id,
        backend_id: backend.id,
        aliases: [...(backend.aliases ?? [])],
        platform: "",
        channel: "",
        channel_id: "",
        installed,
        enabled: state.enabled,
      };
      const version = state.version ?? (dirInstalled ? readVersionRecord(backendDir).version : undefined);
      if (version) plugin.version = version;
      if (state.path) plugin.path = state.path;
      else if (dirInstalled) plugin.path = backendDir;
      plugins.push(plugin);
    }
  }

  const legacyDir = backendsDir(root);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    // 旧后端目录缺失或不可读：manifest 的结果仍然可用。
    entries = [];
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (coveredDirs.has(entry.name)) continue;

    const dir = path.join(legacyDir, entry.name);
    const record = readVersionRecord(dir);
    const plugin: PluginStatus = {
      name: entry.name,
      platform: "",
      channel: "",
      channel_id: "",
      installed: true,
      enabled: false,
      path: dir,
    };
    if (record.version) plugin.version = record.version;
    plugins.push(plugin);
  }

  return plugins;
}

export type SetupRunner = (options: RunPluginSetupOptions) => Promise<RunPluginSetupResult>;

export interface PluginActionOptions {
  root: string;
  name: string;
  action: PluginAction;
  reporter: Reporter;
  /** 旧安装脚本的流式 runner（仅在回退到 scripts/backends/cli.mjs 时使用）。 */
  runner?: StreamRunner;
  restart?: (root: string, reporter: Reporter) => Promise<void>;
  /** 测试注入点；默认 runPluginSetup。 */
  setup?: SetupRunner;
}

export interface PluginActionResult {
  name: string;
  action: PluginAction;
  restarted: boolean;
  /** manifest backend 或旧安装脚本。 */
  source: "extension" | "legacy";
  plugin_id?: string;
  backend_id?: string;
}

interface BackendMatch {
  manifest: ExtensionManifest;
  backend: ExtensionBackend;
}

/** 在已安装 manifest 的 backends 中按 backend.id 或 aliases 精确匹配。 */
function findBackendMatch(root: string, name: string): BackendMatch | undefined {
  for (const extension of listExtensions(root)) {
    const backend = (extension.backends ?? []).find(
      (item) => item.id === name || (item.aliases ?? []).includes(name),
    );
    if (!backend) continue;
    try {
      return { manifest: loadInstalledManifest(root, extension.id), backend };
    } catch {
      // listExtensions 已确认 manifest 可读；此处失败只可能是并发删除，回退旧脚本。
      continue;
    }
  }
  return undefined;
}

/** 旧安装脚本；release 不存在或脚本缺失时返回 undefined（不抛异常）。 */
function legacyCliPath(root: string): string | undefined {
  try {
    const cli = path.join(releaseDir(root), "scripts", "backends", "cli.mjs");
    return exists(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 安装/卸载 facade。
 *
 * 解析顺序：
 * 1. 已安装 manifest 的 backends（id / aliases）→ runPluginSetup；
 * 2. `scripts/backends/cli.mjs` → 旧子进程转发（name 原样）；
 * 3. 都没有 → PLUGIN_UNKNOWN / 退出码 4。
 *
 * 成功路径保持旧行为：整栈重启。
 */
export async function pluginAction(options: PluginActionOptions): Promise<PluginActionResult> {
  const { root, reporter } = options;
  const verb = options.action === "install" ? "安装" : "卸载";

  const match = findBackendMatch(root, options.name);
  if (match) {
    const setup = options.setup ?? runPluginSetup;
    const result = await setup({
      root,
      entry: match.manifest.entry,
      action: options.action,
      plugin: {
        id: match.manifest.id,
        name: match.manifest.name,
        version: match.manifest.version,
      },
      backends: [match.backend.id],
      configSchema: match.manifest.config_schema,
      onLog: (message) =>
        reporter.event({ event: "log", service: options.name, message }),
    });

    if (!result.ok) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.FAIL,
        `${options.name} ${verb}失败：${result.error ?? "setup 未返回错误详情"}`,
      );
    }

    const restart = options.restart ?? restartForConfig;
    await restart(root, reporter);

    return {
      name: options.name,
      action: options.action,
      restarted: true,
      source: "extension",
      plugin_id: match.manifest.id,
      backend_id: match.backend.id,
    };
  }

  const cli = legacyCliPath(root);
  if (!cli) {
    throw new CliError(
      "PLUGIN_UNKNOWN",
      EXIT.INVALID,
      `未知插件：${options.name}。请使用 asg extensions install <owner/repo> 安装插件。`,
    );
  }

  const args = [cli, options.name, options.action, "--root", root, "--json"];
  const runner = options.runner ?? spawnStream;
  const result = await runner(nodePath(root), args, {
    cwd: root,
    env: process.env,
    onLine: (line) => forwardChildLine(reporter, line, options.name),
  });

  if (result.error || result.code !== 0) {
    const previous = path.relative(
      root,
      path.join(backendsDir(root), options.name, "previous.json"),
    );
    const detail = result.error
      ? result.error
      : result.code === null
        ? `信号 ${result.signal ?? "unknown"}`
        : `退出码 ${result.code}`;
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.FAIL,
      `${options.name} ${verb}失败（${detail}）；未自动回滚。原配置备份：${previous}`,
      { plugin: options.name, action: options.action, previous },
    );
  }

  const restart = options.restart ?? restartForConfig;
  await restart(root, reporter);

  return {
    name: options.name,
    action: options.action,
    restarted: true,
    source: "legacy",
  };
}
