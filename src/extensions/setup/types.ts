/** 插件 `setup(ctx)` 的公共契约。
 *
 * 这里的类型同时被父进程（host/runner）与子进程（worker）使用。
 * 设计目标：插件只依赖本文件里的类型和 Node 内置能力，不 import 网关内部模块。
 */

/** setup 在安装生命周期的哪个阶段被调用。 */
export const SETUP_ACTIONS = ["install", "update", "uninstall", "status"] as const;

export type SetupAction = (typeof SETUP_ACTIONS)[number];

export interface SetupPluginInfo {
  id: string;
  name: string;
  version: string;
}

/** 宿主平台；刻意只暴露 os/arch，不暴露 isWindows 之类的派生字段。 */
export type SetupHostOs = "linux" | "darwin" | "win32";

export interface SetupHostInfo {
  os: SetupHostOs;
  arch: string;
}

/**
 * 插件可见的路径集合。
 *
 * - `pluginDir` 是已安装插件的只读目录（入口、manifest、插件自带资源）；
 * - `dataDir` 是插件唯一可写的数据目录；
 * - `tempDir` 是插件可写的临时目录；
 * - `backendDir(id)` 是该插件声明的后端安装目录（位于 dataDir 内）。
 */
export interface SetupPaths {
  root: string;
  pluginDir: string;
  dataDir: string;
  backendDir(id: string): string;
  tempDir: string;
  config: string;
  secrets: string;
}

export interface SetupMkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface SetupRemoveOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface SetupReadFileOptions {
  /** 默认 utf8；二进制内容用 base64。 */
  encoding?: "utf8" | "base64";
}

export interface SetupWriteFileOptions {
  mode?: number;
  append?: boolean;
}

export type SetupFileContent = string | Uint8Array;

export interface SetupExtractOptions {
  /** tar 的 --strip-components；zip 不支持。 */
  stripComponents?: number;
}

export interface SetupDownloadOptions {
  /** 期望的 sha256（十六进制，大小写不敏感）；不匹配会删除文件并报错。 */
  sha256?: string;
  headers?: Record<string, string>;
  /** 日志里的可读名称，默认用目标文件名。 */
  label?: string;
}

export interface SetupFetchOptions {
  headers?: Record<string, string>;
  /** 日志里的可读名称。 */
  label?: string;
}

export interface SetupRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 默认 600000ms；0 表示不限时。 */
  timeoutMs?: number;
  /** 默认 false；为 true 时交给系统 shell 解释 command。 */
  shell?: boolean;
}

export interface SetupRunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** 因超时被宿主终止时为 true。 */
  timedOut?: boolean;
}

export interface SetupConfigApi {
  /** 读取 `gateway.yaml → extensions.<id>.config`；缺省返回 {}。 */
  get(): Promise<Record<string, unknown>>;
  /** 递归合并到现有配置（对象合并、数组/标量替换）。 */
  patch(value: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 整体替换配置。 */
  replace(value: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 按点号路径删除字段；例如 `["retry.times"]`。 */
  unset(paths: string[]): Promise<Record<string, unknown>>;
}

export interface SetupStateApi {
  /** 读取 `dataDir/state.json`；不存在返回 null。 */
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export interface SetupBackendStateApi {
  /** 读取 `dataDir/backends.json` 中某个后端的记录；不存在返回 null。 */
  read(id: string): Promise<unknown>;
  write(id: string, state: unknown): Promise<void>;
  clear(id: string): Promise<void>;
}

/** 传给插件入口 `setup(ctx)` 的上下文。所有文件/网络/进程能力都是父进程 RPC。 */
export interface SetupContext {
  readonly action: SetupAction;
  readonly backends: string[];
  readonly plugin: Readonly<SetupPluginInfo>;
  readonly host: Readonly<SetupHostInfo>;
  readonly paths: SetupPaths;

  log(message: string): void;
  progress(phase: string, detail?: string): void;

  exists(target: string): Promise<boolean>;
  mkdir(target: string, options?: SetupMkdirOptions): Promise<void>;
  remove(target: string, options?: SetupRemoveOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  readFile(file: string, options?: SetupReadFileOptions): Promise<string>;
  writeFile(
    file: string,
    content: SetupFileContent,
    options?: SetupWriteFileOptions,
  ): Promise<void>;
  sha256(file: string): Promise<string>;
  extract(archive: string, dest: string, options?: SetupExtractOptions): Promise<void>;

  download(url: string, dest: string, options?: SetupDownloadOptions): Promise<void>;
  fetchText(url: string, options?: SetupFetchOptions): Promise<string>;
  fetchJson<T = unknown>(url: string, options?: SetupFetchOptions): Promise<T>;

  run(
    command: string,
    args?: readonly string[],
    options?: SetupRunOptions,
  ): Promise<SetupRunResult>;

  readonly config: SetupConfigApi;
  readonly state: SetupStateApi;
  readonly backendState: SetupBackendStateApi;
}

/** 插件入口应导出的 setup 函数。 */
export type SetupFunction = (ctx: SetupContext) => unknown | Promise<unknown>;
