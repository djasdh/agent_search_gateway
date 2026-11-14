/** 外部后端（插件）的列表、安装与卸载。
 *
 * install/remove 通过子进程调用 release 内的 scripts/backends/cli.mjs，
 * 该脚本负责写 gateway.yaml 与 data/backends/<name>/；CLI 只转发事件并在成功后整栈重启。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { exists, nodePath, releaseDir, rootPaths } from "../root.js";
import { restartForConfig } from "../runtime/stack.js";
import { channelById, normalizeChannel } from "../../fetch/channels/registry.js";

export const PLUGIN_NAMES = ["bili", "ytdlp", "opencli", "article"] as const;

export type PluginName = (typeof PLUGIN_NAMES)[number];

/** 安装名 → 规范通道 ID（`platform:channel`）。 */
const PLUGIN_CHANNEL: Record<PluginName, string> = {
  bili: "bilibili:kukemc",
  ytdlp: "bilibili:ytdlp",
  article: "bilibili:article",
  opencli: "weibo:opencli",
};

const CHANNEL_PLUGIN = new Map<string, PluginName>(
  (Object.entries(PLUGIN_CHANNEL) as Array<[PluginName, string]>).map(([name, id]) => [id, name]),
);

/** 安装器可接受的规范通道（用于错误提示）。 */
const CANONICAL_CHANNELS = PLUGIN_NAMES.map((name) => PLUGIN_CHANNEL[name]);

/** 逻辑名 → data/backends 下的目录名（article 的历史目录是 article-server）。 */
const INSTALL_DIR_NAME: Record<PluginName, string> = {
  bili: "bili",
  ytdlp: "ytdlp",
  opencli: "opencli",
  article: "article-server",
};

/** 各插件在 gateway.yaml 中对应的命令字段；非空即视为启用。 */
const CONFIG_KEYS: Record<PluginName, string[]> = {
  bili: ["bilibili", "cli_kukemc", "command"],
  ytdlp: ["bilibili", "cli_ytdlp", "command"],
  opencli: ["weibo", "cli", "command"],
  article: ["bilibili", "http", "command"],
};

export interface PluginStatus {
  name: PluginName;
  /** 规范平台 ID（如 `bilibili`）。 */
  platform: string;
  /** 通道名（如 `kukemc`）。 */
  channel: string;
  /** 完整规范通道 ID（如 `bilibili:kukemc`）。 */
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

function parseEventLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const data: unknown = JSON.parse(trimmed);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
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

export function isPluginName(value: string): value is PluginName {
  return (PLUGIN_NAMES as readonly string[]).includes(value);
}

/**
 * 把用户输入归一化成安装名：
 * 1. 精确匹配旧安装名（bili / ytdlp / opencli / article）；
 * 2. 再按通道 ID 或别名归一化，映射回安装名。
 * `cnki:http` 是内置平台，不可安装，返回 undefined。
 */
export function normalizePluginInput(value: string): PluginName | undefined {
  if (isPluginName(value)) return value;
  const channel = normalizeChannel(value);
  return channel ? CHANNEL_PLUGIN.get(channel.id) : undefined;
}

/** 未知插件名：PLUGIN_UNKNOWN / 退出码 4。 */
export function assertPluginName(value: string): PluginName {
  const name = normalizePluginInput(value);
  if (name) return name;
  const channel = normalizeChannel(value);
  const builtinHint = channel?.id === "cnki:http" ? "；cnki 是内置平台，无需安装" : "";
  throw new CliError(
    "PLUGIN_UNKNOWN",
    EXIT.INVALID,
    `未知插件：${value}（旧名：${PLUGIN_NAMES.join(" / ")}；规范通道：${CANONICAL_CHANNELS.join(" / ")}）${builtinHint}`,
  );
}

export function backendsDir(root: string): string {
  return path.join(root, "data", "backends");
}

export function pluginInstallDir(root: string, name: PluginName): string {
  return path.join(backendsDir(root), INSTALL_DIR_NAME[name]);
}

export function pluginPreviousFile(root: string, name: PluginName): string {
  return path.join(pluginInstallDir(root, name), "previous.json");
}

function readConfig(root: string): Record<string, unknown> {
  try {
    const raw: unknown = YAML.parse(fs.readFileSync(rootPaths(root).config, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // 配置缺失或不可解析：列表仍应离线可用，全部按未启用处理。
  }
  return {};
}

function dig(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function commandEnabled(config: Record<string, unknown>, keys: string[]): boolean {
  const value = dig(config, keys);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return false;
}

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

/** 只读本地文件，离线可用，不触碰网络与服务。 */
export function listPlugins(root: string): PluginStatus[] {
  const config = readConfig(root);
  return PLUGIN_NAMES.map((name) => {
    const dir = pluginInstallDir(root, name);
    const record = readVersionRecord(dir);
    const channel = channelById(PLUGIN_CHANNEL[name]);
    const entry: PluginStatus = {
      name,
      platform: channel?.platform ?? "",
      channel: channel?.channel ?? "",
      channel_id: channel?.id ?? "",
      installed: record.installed,
      enabled: commandEnabled(config, CONFIG_KEYS[name]!),
    };
    if (record.version) entry.version = record.version;
    if (record.installed) entry.path = dir;
    return entry;
  });
}

export interface PluginActionOptions {
  root: string;
  name: string;
  action: PluginAction;
  reporter: Reporter;
  runner?: StreamRunner;
  restart?: (root: string, reporter: Reporter) => Promise<void>;
}

export interface PluginActionResult {
  name: PluginName;
  action: PluginAction;
  restarted: boolean;
}

/** 安装/卸载：子进程执行安装器，事件透传，成功后整栈重启；失败不回滚只报告。 */
export async function pluginAction(options: PluginActionOptions): Promise<PluginActionResult> {
  const { root, reporter } = options;
  const name = assertPluginName(options.name);
  const release = releaseDir(root);
  const cli = path.join(release, "scripts", "backends", "cli.mjs");
  if (!exists(cli)) {
    throw new CliError("PLUGIN_FAILED", EXIT.FAIL, `未找到插件安装器：${cli}`);
  }

  const args = [cli, name, options.action, "--root", root, "--json"];
  const runner = options.runner ?? spawnStream;
  const result = await runner(nodePath(root), args, {
    cwd: root,
    env: process.env,
    onLine: (line) => forwardChildLine(reporter, line, name),
  });

  if (result.error || result.code !== 0) {
    const previous = path.relative(root, pluginPreviousFile(root, name));
    const detail = result.error
      ? result.error
      : result.code === null
        ? `信号 ${result.signal ?? "unknown"}`
        : `退出码 ${result.code}`;
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.FAIL,
      `${name} ${options.action === "install" ? "安装" : "卸载"}失败（${detail}）；未自动回滚。原配置备份：${previous}`,
      { plugin: name, action: options.action, previous },
    );
  }

  const restart = options.restart ?? restartForConfig;
  await restart(root, reporter);

  return { name, action: options.action, restarted: true };
}
