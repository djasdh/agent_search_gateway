/** setup 子进程的父进程宿主：真正执行文件、网络、进程与配置能力。
 *
 * 安全边界（刻意收窄，但**不是**沙箱）：
 * - 写操作只能落在 `dataDir` / `tempDir` 内，插件安装目录（pluginDir）保持只读；
 * - `rename` 的源路径也必须是可写路径，避免把插件文件“搬走”；
 * - 下载只允许 https；
 * - config 只写 `gateway.yaml → extensions.<id>.config`，用 YAML Document 保留注释。
 *
 * 所有错误消息都是中文，并尽量带上路径/命令/URL 上下文，方便插件作者定位问题。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Document, isMap, parseDocument } from "yaml";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { download as httpDownload, sha256File as httpSha256File } from "../../../scripts/install/http.mjs";
import { resolvePluginConfig } from "../config.js";
import { isValidExtensionId } from "../manifest.js";
import type { SetupInitPaths, SetupRpcMethod } from "./protocol.js";
import type {
  SetupDownloadOptions,
  SetupExtractOptions,
  SetupFetchOptions,
  SetupFileContent,
  SetupHostInfo,
  SetupMkdirOptions,
  SetupPluginInfo,
  SetupReadFileOptions,
  SetupRemoveOptions,
  SetupRunOptions,
  SetupRunResult,
  SetupWriteFileOptions,
} from "./types.js";

type HttpDownload = (
  url: string,
  dest: string,
  options?: {
    token?: string;
    logger?: (message: string) => void;
    headers?: Record<string, string>;
  },
) => Promise<unknown>;

type HttpSha256File = (file: string) => Promise<string>;

const downloadFile = httpDownload as HttpDownload;
const sha256File = httpSha256File as HttpSha256File;

/** 单个后端 id 的约束：不能带路径分隔符，首字符必须是字母/数字。 */
const BACKEND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 单个输出流最多保留 4MB，防止插件跑 `yes` 之类命令吃光内存。 */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface SetupHostPaths {
  root: string;
  pluginDir: string;
  dataDir: string;
  tempDir: string;
  config: string;
  secrets: string;
}

export interface SetupHostOptions {
  root: string;
  plugin: SetupPluginInfo;
  logger?: (message: string) => void;
  /** manifest 的 config_schema；提供后所有 config 写入都会先校验。 */
  configSchema?: unknown;
}

interface SpawnCaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  shell: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** 子进程创建后回调，供 SetupHost 跟踪/清理。 */
  onSpawn?: (child: ChildProcess) => void;
}

interface SpawnCaptureResult extends SetupRunResult {
  spawnError?: string;
}

export function resolveSetupPaths(root: string, pluginId: string): SetupHostPaths {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new Error("setup 宿主缺少 root：无法解析插件路径");
  }
  if (!isValidExtensionId(pluginId)) {
    throw new Error(`插件 id 不合法：${pluginId}`);
  }

  const absoluteRoot = path.resolve(root);
  const pluginDir = path.join(absoluteRoot, "data", "extensions", pluginId);
  // 插件更新会原子替换 data/extensions/<id>，所以可写数据必须放在插件目录之外。
  const dataDir = path.join(absoluteRoot, "data", "extension-data", pluginId);
  return {
    root: absoluteRoot,
    pluginDir,
    dataDir,
    tempDir: path.join(dataDir, "tmp"),
    config: path.join(absoluteRoot, "gateway.yaml"),
    secrets: path.join(absoluteRoot, "secrets.yaml"),
  };
}

/** 把路径函数展开成可跨 IPC 的纯数据。worker 侧再拼回 `SetupPaths`。 */
export function setupInitPaths(paths: SetupHostPaths): SetupInitPaths {
  return {
    root: paths.root,
    pluginDir: paths.pluginDir,
    dataDir: paths.dataDir,
    tempDir: paths.tempDir,
    config: paths.config,
    secrets: paths.secrets,
    backendDirBase: path.join(paths.dataDir, "backends"),
  };
}

export function setupHostInfo(): SetupHostInfo {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error(`setup 宿主不支持当前平台：${platform}（只支持 linux / darwin / win32）`);
  }
  return { os: platform, arch: process.arch };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}必须是非空字符串`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label}包含非法字符（NUL）`);
  }
  return value;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  // JSON IPC 会把尾部 undefined 传成 null；两者都视为“未提供”。
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value;
}

function assertBackendId(value: unknown): string {
  if (typeof value !== "string" || !BACKEND_ID_RE.test(value)) {
    throw new Error(
      `后端 id 不合法：${String(value)}（只允许字母/数字/._-，首字符必须是字母或数字，最长 64）`,
    );
  }
  return value;
}

function normalizeCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normalizeCompare(parent), normalizeCompare(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** 解析最近一个存在祖先的真实路径，再拼回不存在的尾部。 */
async function realpathNearest(target: string): Promise<string> {
  const absolute = path.resolve(target);
  let current = absolute;
  const tail: string[] = [];

  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return tail.length > 0 ? path.join(real, ...[...tail].reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  const next = current + chunk;
  return next.length > MAX_CAPTURE_BYTES
    ? `${next.slice(0, MAX_CAPTURE_BYTES)}\n…（输出超过 ${MAX_CAPTURE_BYTES} 字节，已截断）`
    : next;
}

function createLineSplitter(onLine?: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";
  const emit = (line: string): void => {
    if (!onLine) return;
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.length > 0) onLine(trimmed);
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        emit(line);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        const line = buffer;
        buffer = "";
        emit(line);
      }
    },
  };
}

/** 杀掉命令自身的进程组；Windows 用 taskkill /T /F 覆盖整棵进程树。 */
function killProcessTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // 进程可能已退出
    }
    return;
  }

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        // 父进程正在退出时，taskkill 也要能继续完成。
        detached: true,
      });
      killer.unref();
      killer.once("error", () => {
        try {
          child.kill(force ? "SIGKILL" : "SIGTERM");
        } catch {
          // 已退出
        }
      });
    } catch {
      try {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        // 已退出
      }
    }
    return;
  }

  try {
    // 非 Windows：spawn 时 detached:true 让子进程成为新进程组组长。
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // 已退出
    }
  }
}

function spawnCapture(
  command: string,
  args: string[],
  options: SpawnCaptureOptions,
): Promise<SpawnCaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    const stdoutLines = createLineSplitter(options.onStdoutLine);
    const stderrLines = createLineSplitter(options.onStderrLine);

    const finish = (
      code: number | null,
      signal: string | null,
      spawnError?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (hardTimer) clearTimeout(hardTimer);
      stdoutLines.flush();
      stderrLines.flush();
      resolve({ code, signal, stdout, stderr, timedOut, ...(spawnError ? { spawnError } : {}) });
    };

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell,
        stdio: ["ignore", "pipe", "pipe"],
        // 非 Windows 建立独立进程组，超时/dispose 时才能连同孙进程一起杀。
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      finish(null, null, `无法执行命令 ${command}：${messageOf(error)}`);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout = appendCapped(stdout, text);
      stdoutLines.push(text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr = appendCapped(stderr, text);
      stderrLines.push(text);
    });

    child.once("error", (error) => {
      const detail = `无法执行命令 ${command}：${messageOf(error)}`;
      stderr = appendCapped(stderr, `${stderr ? "\n" : ""}${detail}`);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, null, detail);
    });

    // 直接子进程退出后，孙进程可能仍持有继承来的 stdout/stderr，导致 close 永不触发。
    // 给 150ms drain 窗口，随后主动 destroy 管道并 settle；已捕获输出保留。
    child.once("exit", (code, signal) => {
      if (settled) return;
      exitCode = code;
      exitSignal = signal ?? null;
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode, exitSignal);
      }, 150);
    });

    child.once("close", (code, signal) => {
      finish(code, signal ?? null);
    });

    options.onSpawn?.(child);

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        const timeoutLine = `命令超时（${options.timeoutMs}ms）：${command}，已终止`;
        stderr = appendCapped(stderr, `${stderr ? "\n" : ""}${timeoutLine}`);
        if (options.onStderrLine) options.onStderrLine(timeoutLine);
        killProcessTree(child, false);
        killTimer = setTimeout(() => killProcessTree(child, true), 1_500);
        killTimer.unref?.();
        // 极端情况下进程/管道仍不响应，不能永久挂起调用方。
        hardTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(null, "SIGKILL");
        }, 3_000);
      }, options.timeoutMs);
    }
  });
}

function assertHttpsUrl(value: unknown, label: string): URL {
  const raw = requireString(value, `${label}的下载地址`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label}的下载地址无效：${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label}只允许 https 下载地址，收到：${raw}`);
  }
  return parsed;
}

function parseHeaders(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label}的 headers 必须是对象`);
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new Error(`${label}的 headers.${key} 必须是字符串`);
    }
    headers[key] = raw;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseDownloadOptions(value: unknown): SetupDownloadOptions {
  const raw = optionalRecord(value, "download 的 options");
  const options: SetupDownloadOptions = {};
  if (raw.sha256 !== undefined) {
    if (typeof raw.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(raw.sha256)) {
      throw new Error("download 的 options.sha256 必须是 64 位十六进制字符串");
    }
    options.sha256 = raw.sha256.toLowerCase();
  }
  if (raw.label !== undefined) {
    options.label = requireString(raw.label, "download 的 options.label");
  }
  const headers = parseHeaders(raw.headers, "download");
  if (headers) options.headers = headers;
  return options;
}

function parseFetchOptions(value: unknown, method: string): SetupFetchOptions {
  const raw = optionalRecord(value, `${method} 的 options`);
  const options: SetupFetchOptions = {};
  if (raw.label !== undefined) {
    options.label = requireString(raw.label, `${method} 的 options.label`);
  }
  const headers = parseHeaders(raw.headers, method);
  if (headers) options.headers = headers;
  return options;
}

function parseMkdirOptions(value: unknown): SetupMkdirOptions {
  const raw = optionalRecord(value, "mkdir 的 options");
  const options: SetupMkdirOptions = {};
  if (raw.recursive !== undefined) {
    if (typeof raw.recursive !== "boolean") {
      throw new Error("mkdir 的 options.recursive 必须是布尔值");
    }
    options.recursive = raw.recursive;
  }
  if (raw.mode !== undefined) {
    if (!Number.isInteger(raw.mode) || (raw.mode as number) < 0 || (raw.mode as number) > 0o777) {
      throw new Error("mkdir 的 options.mode 必须是 0..0777 的整数");
    }
    options.mode = raw.mode as number;
  }
  return options;
}

function parseRemoveOptions(value: unknown): SetupRemoveOptions {
  const raw = optionalRecord(value, "remove 的 options");
  const options: SetupRemoveOptions = {};
  for (const key of ["recursive", "force"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") {
        throw new Error(`remove 的 options.${key} 必须是布尔值`);
      }
      options[key] = raw[key] as boolean;
    }
  }
  return options;
}

function parseReadFileOptions(value: unknown): SetupReadFileOptions {
  const raw = optionalRecord(value, "readFile 的 options");
  if (raw.encoding === undefined) return {};
  if (raw.encoding !== "utf8" && raw.encoding !== "base64") {
    throw new Error('readFile 的 options.encoding 只能是 "utf8" 或 "base64"');
  }
  return { encoding: raw.encoding };
}

function parseWriteFileOptions(value: unknown): SetupWriteFileOptions {
  const raw = optionalRecord(value, "writeFile 的 options");
  const options: SetupWriteFileOptions = {};
  if (raw.mode !== undefined) {
    if (!Number.isInteger(raw.mode) || (raw.mode as number) < 0 || (raw.mode as number) > 0o777) {
      throw new Error("writeFile 的 options.mode 必须是 0..0777 的整数");
    }
    options.mode = raw.mode as number;
  }
  if (raw.append !== undefined) {
    if (typeof raw.append !== "boolean") {
      throw new Error("writeFile 的 options.append 必须是布尔值");
    }
    options.append = raw.append;
  }
  return options;
}

function parseExtractOptions(value: unknown): SetupExtractOptions {
  const raw = optionalRecord(value, "extract 的 options");
  if (raw.stripComponents === undefined) return {};
  if (
    !Number.isInteger(raw.stripComponents) ||
    (raw.stripComponents as number) < 0 ||
    (raw.stripComponents as number) > 32
  ) {
    throw new Error("extract 的 options.stripComponents 必须是 0..32 的整数");
  }
  return { stripComponents: raw.stripComponents as number };
}

function parseRunOptions(value: unknown): {
  options: SetupRunOptions;
  env?: NodeJS.ProcessEnv;
} {
  const raw = optionalRecord(value, "run 的 options");
  const options: SetupRunOptions = {};
  let env: NodeJS.ProcessEnv | undefined;

  if (raw.cwd !== undefined) {
    options.cwd = requireString(raw.cwd, "run 的 options.cwd");
  }
  if (raw.timeoutMs !== undefined) {
    if (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 0) {
      throw new Error("run 的 options.timeoutMs 必须是非负整数");
    }
    options.timeoutMs = raw.timeoutMs as number;
  }
  if (raw.shell !== undefined) {
    if (typeof raw.shell !== "boolean") {
      throw new Error("run 的 options.shell 必须是布尔值");
    }
    options.shell = raw.shell;
  }
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) throw new Error("run 的 options.env 必须是对象");
    env = { ...process.env };
    for (const [key, item] of Object.entries(raw.env)) {
      if (item === undefined) {
        delete env[key];
        continue;
      }
      if (typeof item !== "string") {
        throw new Error(`run 的 options.env.${key} 必须是字符串`);
      }
      env[key] = item;
    }
    options.env = { ...raw.env } as Record<string, string | undefined>;
  }

  return { options, ...(env ? { env } : {}) };
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (isRecord(base) && isRecord(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = deepMerge(base[key], value);
    }
    return out;
  }
  return structuredClone(patch);
}

function dig(value: unknown, segments: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function cloneRecord(value: Record<string, unknown>, label: string): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error(`${label}必须是可克隆的普通对象：${messageOf(error)}`);
  }
}

export class SetupHost {
  readonly paths: SetupHostPaths;
  readonly plugin: SetupPluginInfo;
  private readonly logger?: (message: string) => void;
  private readonly configSchema?: unknown;
  /** 在途 proc.run 子进程；dispose 时整棵进程树杀掉。 */
  private readonly activeChildren = new Set<ChildProcess>();
  /** 按文件串行化的 Promise 链，避免并发读-改-写丢数据。 */
  private readonly fileQueues = new Map<string, Promise<void>>();

  constructor(options: SetupHostOptions) {
    if (!isRecord(options.plugin)) {
      throw new Error("setup 宿主缺少插件信息");
    }
    this.plugin = {
      id: options.plugin.id,
      name: options.plugin.name,
      version: options.plugin.version,
    };
    this.paths = resolveSetupPaths(options.root, this.plugin.id);
    this.logger = options.logger;
    this.configSchema = options.configSchema;
  }

  initPaths(): SetupInitPaths {
    return setupInitPaths(this.paths);
  }

  /** runner 收到 worker 的 call 后走这里；参数在具体方法内做运行时校验。 */
  async dispatch(method: SetupRpcMethod, args: readonly unknown[]): Promise<unknown> {
    const list = [...args];
    switch (method) {
      case "fs.exists":
        return this.fsExists(list[0]);
      case "fs.mkdir":
        return this.fsMkdir(list[0], list[1]);
      case "fs.remove":
        return this.fsRemove(list[0], list[1]);
      case "fs.rename":
        return this.fsRename(list[0], list[1]);
      case "fs.copy":
        return this.fsCopy(list[0], list[1]);
      case "fs.readFile":
        return this.fsReadFile(list[0], list[1]);
      case "fs.writeFile":
        return this.fsWriteFile(list[0], list[1], list[2]);
      case "fs.sha256":
        return this.fsSha256(list[0]);
      case "fs.extract":
        return this.fsExtract(list[0], list[1], list[2]);
      case "net.download":
        return this.netDownload(list[0], list[1], list[2]);
      case "net.fetchText":
        return this.netFetchText(list[0], list[1]);
      case "net.fetchJson":
        return this.netFetchJson(list[0], list[1]);
      case "proc.run":
        return this.procRun(list[0], list[1], list[2]);
      case "config.get":
        return this.configGet();
      case "config.patch":
        return this.configPatch(list[0]);
      case "config.replace":
        return this.configReplace(list[0]);
      case "config.unset":
        return this.configUnset(list[0]);
      case "state.read":
        return this.stateRead();
      case "state.write":
        return this.stateWrite(list[0]);
      case "backendState.read":
        return this.backendStateRead(list[0]);
      case "backendState.write":
        return this.backendStateWrite(list[0], list[1]);
      case "backendState.clear":
        return this.backendStateClear(list[0]);
      default:
        throw new Error(`未知的 setup RPC 方法：${String(method)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 路径与文件
  // ---------------------------------------------------------------------------

  private log(message: string): void {
    this.logger?.(message);
  }

  /** runner 结束（done/error/timeout/父进程退出）时调用，杀掉所有在途命令树。 */
  dispose(): void {
    for (const child of [...this.activeChildren]) {
      killProcessTree(child, true);
    }
    this.activeChildren.clear();
  }

  /** 同一文件上的操作串行执行；前一个失败不会阻塞后续任务。 */
  private enqueueFile<T>(file: string, task: () => Promise<T>): Promise<T> {
    const previous = this.fileQueues.get(file) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.fileQueues.set(file, tail);
    void tail.then(() => {
      if (this.fileQueues.get(file) === tail) this.fileQueues.delete(file);
    });
    return run;
  }

  private resolveTarget(value: unknown, label: string): string {
    const raw = requireString(value, label);
    return path.resolve(this.paths.dataDir, raw);
  }

  /** 写入路径必须位于 dataDir/tempDir；同时校验真实路径，防止符号链接逃逸。 */
  private async resolveForWrite(value: unknown, label: string): Promise<string> {
    const target = this.resolveTarget(value, label);
    const roots = [this.paths.dataDir, this.paths.tempDir];

    if (!roots.some((root) => isInside(target, root))) {
      throw new Error(
        `${label}路径越界：${target} 不在允许的写入目录内（只允许 ${roots.join("、")}）`,
      );
    }

    const realTarget = await realpathNearest(target);
    const realRoots = await Promise.all(roots.map((root) => realpathNearest(root)));
    if (!realRoots.some((root) => isInside(realTarget, root))) {
      throw new Error(
        `${label}路径越界：真实路径 ${realTarget} 不在允许的写入目录内（可能是符号链接）`,
      );
    }

    return target;
  }

  private async fsExists(value: unknown): Promise<boolean> {
    const target = this.resolveTarget(value, "exists 的目标");
    try {
      await fsp.access(target, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async fsMkdir(value: unknown, rawOptions: unknown): Promise<void> {
    const target = await this.resolveForWrite(value, "mkdir 的目标");
    const options = parseMkdirOptions(rawOptions);
    await fsp.mkdir(target, {
      recursive: options.recursive ?? true,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
  }

  private async fsRemove(value: unknown, rawOptions: unknown): Promise<void> {
    const target = await this.resolveForWrite(value, "remove 的目标");
    const options = parseRemoveOptions(rawOptions);
    await fsp.rm(target, {
      recursive: options.recursive ?? true,
      force: options.force ?? true,
    });
  }

  private async fsRename(fromValue: unknown, toValue: unknown): Promise<void> {
    // rename 会删除源路径，所以源也必须在可写目录内，避免把插件安装目录里的文件搬走。
    const from = await this.resolveForWrite(fromValue, "rename 的源");
    const to = await this.resolveForWrite(toValue, "rename 的目标");
    await fsp.rename(from, to);
  }

  private async fsCopy(fromValue: unknown, toValue: unknown): Promise<void> {
    const from = this.resolveTarget(fromValue, "copy 的源");
    const to = await this.resolveForWrite(toValue, "copy 的目标");
    if (isInside(to, from)) {
      throw new Error(`copy 的目标不能位于源目录内部：${to}`);
    }
    await fsp.cp(from, to, { recursive: true, force: true });
  }

  private async fsReadFile(value: unknown, rawOptions: unknown): Promise<string> {
    const file = this.resolveTarget(value, "readFile 的文件");
    const options = parseReadFileOptions(rawOptions);
    try {
      return await fsp.readFile(file, { encoding: options.encoding ?? "utf8" });
    } catch (error) {
      throw new Error(`读取文件失败：${file}：${messageOf(error)}`);
    }
  }

  private async fsWriteFile(
    value: unknown,
    content: unknown,
    rawOptions: unknown,
  ): Promise<void> {
    const file = await this.resolveForWrite(value, "writeFile 的文件");
    const options = parseWriteFileOptions(rawOptions);

    let data: string | Uint8Array;
    if (typeof content === "string") {
      data = content;
    } else if (content instanceof Uint8Array) {
      data = content;
    } else {
      throw new Error("writeFile 的 content 必须是字符串或 Uint8Array");
    }

    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (options.append) {
        await fsp.appendFile(file, data);
      } else {
        await fsp.writeFile(file, data, options.mode !== undefined ? { mode: options.mode } : {});
      }
    } catch (error) {
      throw new Error(`写入文件失败：${file}：${messageOf(error)}`);
    }
  }

  private async fsSha256(value: unknown): Promise<string> {
    const file = this.resolveTarget(value, "sha256 的文件");
    try {
      return (await sha256File(file)).toLowerCase();
    } catch (error) {
      throw new Error(`计算 SHA256 失败：${file}：${messageOf(error)}`);
    }
  }

  private async fsExtract(
    archiveValue: unknown,
    destValue: unknown,
    rawOptions: unknown,
  ): Promise<void> {
    const archive = this.resolveTarget(archiveValue, "extract 的压缩包");
    const dest = await this.resolveForWrite(destValue, "extract 的目标目录");
    const options = parseExtractOptions(rawOptions);
    const name = path.basename(archive).toLowerCase();

    let command: string;
    let args: string[];
    let fallback: { command: string; args: string[] } | undefined;

    if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
      command = "tar";
      args = [
        "-xzf",
        archive,
        "-C",
        dest,
        ...(options.stripComponents ? [`--strip-components=${options.stripComponents}`] : []),
      ];
    } else if (name.endsWith(".zip")) {
      if (options.stripComponents) {
        throw new Error("extract 的 stripComponents 只支持 tar 压缩包，zip 不支持");
      }
      command = "unzip";
      args = ["-o", archive, "-d", dest];
      // Windows / 精简容器里可能没有 unzip；bsdtar 通常能解 zip。
      fallback = { command: "tar", args: ["-xf", archive, "-C", dest] };
    } else {
      throw new Error(`不支持的压缩格式：${archive}（只支持 .tar.gz / .tgz / .zip）`);
    }

    await fsp.mkdir(dest, { recursive: true });
    this.log(`解压 ${path.basename(archive)} → ${dest}`);

    const first = await spawnCapture(command, args, {
      timeoutMs: 600_000,
      shell: false,
    });
    if (first.code === 0) return;

    if (fallback) {
      const second = await spawnCapture(fallback.command, fallback.args, {
        timeoutMs: 600_000,
        shell: false,
      });
      if (second.code === 0) return;
      const firstDetail = first.spawnError ?? first.stderr.trim() ?? `退出码 ${String(first.code)}`;
      const secondDetail =
        second.spawnError ?? second.stderr.trim() ?? `退出码 ${String(second.code)}`;
      throw new Error(
        `解压失败：${archive}\n  ${command}: ${firstDetail || "未知错误"}\n  ${fallback.command}: ${secondDetail || "未知错误"}`,
      );
    }

    const detail = first.spawnError ?? first.stderr.trim();
    throw new Error(
      `解压失败（${command}）：${archive}${detail ? `：${detail}` : `：退出码 ${String(first.code)}`}`,
    );
  }

  // ---------------------------------------------------------------------------
  // 网络
  // ---------------------------------------------------------------------------

  private async netDownload(
    urlValue: unknown,
    destValue: unknown,
    rawOptions: unknown,
  ): Promise<void> {
    const options = parseDownloadOptions(rawOptions);
    const label = options.label ?? "下载文件";
    assertHttpsUrl(urlValue, label);
    const url = urlValue as string;
    const dest = await this.resolveForWrite(destValue, `${label}的目标路径`);

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = path.join(
      path.dirname(dest),
      `.${path.basename(dest)}.part-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
    );
    this.log(`${label}：${url}`);

    try {
      try {
        await downloadFile(url, part, {
          ...(options.headers ? { headers: options.headers } : {}),
          logger: (message: string) => this.log(message),
        });
      } catch (error) {
        throw new Error(`下载失败：${label}（${url}）：${messageOf(error)}`);
      }

      if (options.sha256) {
        let actual: string;
        try {
          actual = (await sha256File(part)).toLowerCase();
        } catch (error) {
          throw new Error(`下载完成但无法计算 SHA256：${part}：${messageOf(error)}`);
        }
        if (actual !== options.sha256) {
          throw new Error(
            `SHA256 校验失败：${label}\n  期望: ${options.sha256}\n  实际: ${actual}\n  临时文件已删除，原文件未改动：${dest}`,
          );
        }
        this.log(`${label} SHA256 校验通过`);
      }

      // 只有下载与校验都成功才替换目标；失败时旧的好文件保持原样。
      await fsp.rename(part, dest);
    } finally {
      await fsp.rm(part, { force: true }).catch(() => {});
    }
  }

  private async netFetchText(urlValue: unknown, rawOptions: unknown): Promise<string> {
    const options = parseFetchOptions(rawOptions, "fetchText");
    const label = options.label ?? "fetchText";
    assertHttpsUrl(urlValue, label);
    const url = urlValue as string;

    await fsp.mkdir(this.paths.tempDir, { recursive: true });
    const tempFile = path.join(
      this.paths.tempDir,
      `.fetch-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.tmp`,
    );

    try {
      await this.netDownload(url, tempFile, {
        ...(options.headers ? { headers: options.headers } : {}),
        label,
      });
      return await fsp.readFile(tempFile, "utf8");
    } finally {
      await fsp.rm(tempFile, { force: true }).catch(() => {});
    }
  }

  private async netFetchJson(urlValue: unknown, rawOptions: unknown): Promise<unknown> {
    const options = parseFetchOptions(rawOptions, "fetchJson");
    const text = await this.netFetchText(urlValue, options);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`fetchJson 解析失败：${String(urlValue)}：${messageOf(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 进程
  // ---------------------------------------------------------------------------

  private async procRun(
    commandValue: unknown,
    argsValue: unknown,
    rawOptions: unknown,
  ): Promise<SetupRunResult> {
    const command = requireString(commandValue, "run 的命令");
    const hasArgs = argsValue !== undefined && argsValue !== null;
    if (
      hasArgs &&
      (!Array.isArray(argsValue) || argsValue.some((item) => typeof item !== "string"))
    ) {
      throw new Error("run 的 args 必须是字符串数组");
    }
    const args = hasArgs ? (argsValue as string[]) : [];
    const { options, env } = parseRunOptions(rawOptions);

    let cwd: string | undefined;
    if (options.cwd !== undefined) {
      cwd = path.resolve(this.paths.dataDir, options.cwd);
      const stat = await fsp.stat(cwd).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new Error(`run 的 cwd 不存在或不是目录：${cwd}`);
      }
    }

    let spawned: ChildProcess | undefined;
    const result = await spawnCapture(command, args, {
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      timeoutMs: options.timeoutMs ?? 600_000,
      shell: options.shell ?? false,
      onStdoutLine: (line) => this.log(line),
      onStderrLine: (line) => this.log(`[stderr] ${line}`),
      onSpawn: (child) => {
        spawned = child;
        this.activeChildren.add(child);
        const cleanup = (): void => {
          this.activeChildren.delete(child);
        };
        child.once("exit", cleanup);
        child.once("error", cleanup);
      },
    });
    if (spawned) this.activeChildren.delete(spawned);

    return {
      code: result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.timedOut ? { timedOut: true } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // gateway.yaml 配置
  // ---------------------------------------------------------------------------

  private configSegments(): string[] {
    return ["extensions", this.plugin.id, "config"];
  }

  /** 读取 gateway.yaml；文件缺失/解析失败都给明确的中文错误。 */
  private loadGatewayDocument(): Document.Parsed {
    const file = this.paths.config;
    if (!fs.existsSync(file)) {
      throw new Error(
        `未找到网关配置文件：${file}。setup 的 config 操作需要 gateway.yaml 已存在。`,
      );
    }

    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`无法读取网关配置文件：${file}：${messageOf(error)}`);
    }

    let doc: Document.Parsed;
    try {
      doc = parseDocument(text) as Document.Parsed;
    } catch (error) {
      throw new Error(`网关配置文件解析失败：${file}：${messageOf(error)}`);
    }
    if (doc.errors.length > 0) {
      throw new Error(
        `网关配置文件解析失败：${file}：${doc.errors.map((error) => error.message).join("；")}`,
      );
    }
    if (doc.contents !== null && doc.contents !== undefined && !isMap(doc.contents)) {
      throw new Error(`网关配置文件内容必须是 YAML 对象：${file}`);
    }
    return doc;
  }

  private configValue(doc: Document.Parsed): Record<string, unknown> {
    let plain: unknown;
    try {
      plain = doc.toJS();
    } catch (error) {
      throw new Error(`无法读取网关配置：${this.paths.config}：${messageOf(error)}`);
    }
    const value = dig(plain, this.configSegments());
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) {
      throw new Error(
        `gateway.yaml 中 extensions.${this.plugin.id}.config 必须是对象：${this.paths.config}`,
      );
    }
    return structuredClone(value);
  }

  private pruneConfig(doc: Document.Parsed): void {
    const configPath = this.configSegments();
    const configNode = doc.getIn(configPath, true);
    if (isMap(configNode) && configNode.items.length === 0) {
      doc.deleteIn(configPath);
    }

    const pluginPath = ["extensions", this.plugin.id];
    const pluginNode = doc.getIn(pluginPath, true);
    if (isMap(pluginNode) && pluginNode.items.length === 0) {
      doc.deleteIn(pluginPath);
    }
  }

  private async writeGatewayDocument(doc: Document.Parsed): Promise<void> {
    const text = doc.toString({ lineWidth: 0 });
    await this.atomicWrite(this.paths.config, text.endsWith("\n") ? text : `${text}\n`);
  }

  private async atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let mode = 0o644;
    try {
      mode = (await fsp.stat(file)).mode & 0o777;
    } catch {
      // 文件不存在时用默认权限
    }

    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
    );
    try {
      await fsp.writeFile(temp, data, { mode });
      await fsp.chmod(temp, mode);
      await fsp.rename(temp, file);
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {});
    }
  }

  /** 按 manifest config_schema 校验候选配置；undefined 时保持“只要求是对象”的旧行为。 */
  private assertConfigCandidate(candidate: Record<string, unknown>): void {
    if (this.configSchema === undefined) return;

    let result;
    try {
      result = resolvePluginConfig(
        this.configSchema as Record<string, unknown>,
        candidate,
      );
    } catch (error) {
      throw new Error(
        `插件配置校验失败（extensions.${this.plugin.id}.config）：${messageOf(error)}`,
      );
    }
    if (!result.ok) {
      throw new Error(
        `插件配置校验失败（extensions.${this.plugin.id}.config）：${result.error}`,
      );
    }
  }

  private async configGet(): Promise<Record<string, unknown>> {
    return this.enqueueFile(this.paths.config, async () =>
      this.configValue(this.loadGatewayDocument()),
    );
  }

  private async configPatch(value: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(value)) throw new Error("config.patch 的值必须是对象");
    const patch = cloneRecord(value, "config.patch 的值");
    return this.enqueueFile(this.paths.config, async () => {
      const doc = this.loadGatewayDocument();
      const candidate = deepMerge(this.configValue(doc), patch) as Record<string, unknown>;
      this.assertConfigCandidate(candidate);
      doc.setIn(this.configSegments(), candidate);
      await this.writeGatewayDocument(doc);
      return this.configValue(doc);
    });
  }

  private async configReplace(value: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(value)) throw new Error("config.replace 的值必须是对象");
    const replacement = cloneRecord(value, "config.replace 的值");
    return this.enqueueFile(this.paths.config, async () => {
      const doc = this.loadGatewayDocument();
      this.assertConfigCandidate(replacement);
      doc.setIn(this.configSegments(), replacement);
      await this.writeGatewayDocument(doc);
      return this.configValue(doc);
    });
  }

  private async configUnset(pathsValue: unknown): Promise<Record<string, unknown>> {
    if (
      !Array.isArray(pathsValue) ||
      pathsValue.length === 0 ||
      pathsValue.some((item) => typeof item !== "string")
    ) {
      throw new Error("config.unset 的 paths 必须是非空字符串数组");
    }

    return this.enqueueFile(this.paths.config, async () => {
      const doc = this.loadGatewayDocument();
      const base = this.configSegments();
      for (const raw of pathsValue as string[]) {
        const trimmed = raw.trim();
        if (!trimmed) throw new Error("config.unset 的路径不能为空");
        const segments = trimmed.split(".");
        if (segments.some((segment) => segment.length === 0)) {
          throw new Error(`config.unset 的路径不合法：${raw}`);
        }
        const target = [...base, ...segments];
        doc.deleteIn(target);

        // 自底向上清理空对象，避免留下 `nested: {}` 这类空壳。
        for (let depth = target.length - 1; depth >= base.length; depth -= 1) {
          const parent = target.slice(0, depth);
          const node = doc.getIn(parent, true);
          if (isMap(node) && node.items.length === 0) {
            doc.deleteIn(parent);
            continue;
          }
          break;
        }
      }
      this.pruneConfig(doc);
      const candidate = this.configValue(doc);
      this.assertConfigCandidate(candidate);
      await this.writeGatewayDocument(doc);
      return this.configValue(doc);
    });
  }

  // ---------------------------------------------------------------------------
  // state / backendState
  // ---------------------------------------------------------------------------

  private stateFile(): string {
    return path.join(this.paths.dataDir, "state.json");
  }

  private backendStateFile(): string {
    return path.join(this.paths.dataDir, "backends.json");
  }

  private async readJsonFile(file: string, label: string): Promise<unknown> {
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`无法读取${label}：${file}：${messageOf(error)}`);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`${label}不是合法 JSON：${file}：${messageOf(error)}`);
    }
  }

  private async writeJsonFile(file: string, value: unknown, label: string): Promise<void> {
    if (value === undefined) {
      throw new Error(`${label}不能是 undefined`);
    }
    let text: string | undefined;
    try {
      text = JSON.stringify(value, null, 2);
    } catch (error) {
      throw new Error(`${label}无法序列化为 JSON：${messageOf(error)}`);
    }
    if (text === undefined) {
      throw new Error(`${label}无法序列化为 JSON（值类型不支持）`);
    }
    await this.atomicWrite(file, `${text}\n`);
  }

  private async stateRead(): Promise<unknown> {
    return this.enqueueFile(this.stateFile(), async () =>
      this.readJsonFile(this.stateFile(), "state.json"),
    );
  }

  private async stateWrite(value: unknown): Promise<void> {
    await this.enqueueFile(this.stateFile(), async () => {
      await this.writeJsonFile(this.stateFile(), value, "state");
    });
  }

  private async backendStateMap(): Promise<Record<string, unknown>> {
    const value = await this.readJsonFile(this.backendStateFile(), "backends.json");
    if (value === null) return {};
    if (!isRecord(value)) {
      throw new Error(`backends.json 必须是 JSON 对象：${this.backendStateFile()}`);
    }
    return structuredClone(value);
  }

  private async backendStateRead(idValue: unknown): Promise<unknown> {
    const id = assertBackendId(idValue);
    return this.enqueueFile(this.backendStateFile(), async () => {
      const map = await this.backendStateMap();
      return map[id] === undefined ? null : structuredClone(map[id]);
    });
  }

  private async backendStateWrite(idValue: unknown, state: unknown): Promise<void> {
    const id = assertBackendId(idValue);
    if (state === undefined) {
      throw new Error(`backendState.write(${id}) 的 state 不能是 undefined`);
    }
    await this.enqueueFile(this.backendStateFile(), async () => {
      const map = await this.backendStateMap();
      map[id] = state;
      await this.writeJsonFile(this.backendStateFile(), map, "backends.json");
    });
  }

  private async backendStateClear(idValue: unknown): Promise<void> {
    const id = assertBackendId(idValue);
    await this.enqueueFile(this.backendStateFile(), async () => {
      const map = await this.backendStateMap();
      if (!Object.hasOwn(map, id)) return;
      delete map[id];
      await this.writeJsonFile(this.backendStateFile(), map, "backends.json");
    });
  }
}
