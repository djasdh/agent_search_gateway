/** `asg extensions search|install|list|remove|config|secret`。
 *
 * 安装/卸载只负责插件目录，**不自动重启网关**；网关下次启动（或运行
 * `asg engines`）时由 `src/extensions/loader.ts` 加载。
 *
 * `config` / `secret` 写的是网关配置文件（`gateway.yaml` 的 `extensions.<id>.config`
 * 与 `secrets.yaml` 的 `extensions.<id>.<name>`），因此和其他配置命令一样：
 * 先整体校验一次，再写一次文件，最后整栈重启一次。校验失败不落盘。
 */

import { existsSync, rmSync } from "node:fs";
import process from "node:process";
import { takeFlag, takeNumber, takeValue } from "../args.js";
import type { CommandFn, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { restartForConfig } from "../runtime/stack.js";
import {
  backendInstallDir,
  normalizeBackendState,
  extensionDataDir,
  readBackendStates,
} from "../../extensions/paths.js";
import {
  configPaths,
  deleteYamlPath,
  documentToPlain,
  documentToText,
  getYamlPath,
  parseConfigValue,
  readYamlDocument,
  setYamlPath,
  writeConfigFile,
  type ConfigPaths,
  type LoadedDocument,
} from "../config/gateway.js";
import { validateConfigTexts } from "../config/validate.js";
import {
  describePluginConfig,
  resolvePluginConfig,
  type ConfigFieldInfo,
  type PluginConfig,
} from "../../extensions/config.js";
import {
  installExtension,
  isValidExtensionVersion,
  isValidRepo,
  listExtensions,
  loadInstalledManifest,
  removeExtension,
  searchExtensions,
  type ExtensionBackend,
  type ExtensionManifest,
  type ExtensionSearchItem,
  type InstalledExtension,
} from "../../extensions/index.js";
import {
  runPluginSetup,
  type RunPluginSetupOptions,
  type RunPluginSetupResult,
} from "../../extensions/setup/runner.js";
import type { SetupAction } from "../../extensions/setup/types.js";

const RESTART_NOTICE = "整栈重启会断开所有 MCP 连接。";

/** 插件密钥名：与 `asg engines secret` 的扩展密钥规则一致。 */
const EXTENSION_SECRET_NAME = /^[a-z][a-z0-9_-]*$/;

const CONFIG_USAGE =
  "用法: asg extensions config <id> [--get [key]] [--set key=value]... [--unset key]... [--file <path>] [--describe]";

const SECRET_USAGE =
  "用法: asg extensions secret <id> --name <name> --stdin | --clear";

const INSTALL_USAGE =
  "用法: asg extensions install <owner/repo>[@version] [--backend <id>]... [--no-setup]";

const SETUP_USAGE =
  "用法: asg extensions setup <id> [--backend <id>]... [--status] [--uninstall]";

const REMOVE_USAGE = "用法: asg extensions remove <id> [--keep-data] [--force]";

const USAGE = `用法: asg extensions <search|install|setup|list|remove|config|secret> ...

  search [query] [--limit N]       搜索 topic:asg-plugin 的 GitHub 仓库
  install <owner/repo>[@version] [--backend <id>]... [--no-setup]
                                   下载、校验并安装第三方插件；默认执行 manifest 声明的全部后端 setup
  setup <id> [--backend <id>]... [--status] [--uninstall]
                                   单独执行已安装插件的 setup（默认 action=install）
  list                             列出已安装的第三方插件与后端状态
  remove <id> [--keep-data] [--force]
                                   先执行后端卸载 setup，再删除插件目录
  config <id> [--get [key]] [--set key=value]... [--unset key]... [--file <path>] [--describe]
                                   读写 gateway.yaml → extensions.<id>.config
  secret <id> --name <name> --stdin | --clear
                                   写/删 secrets.yaml → extensions.<id>.<name>

说明：install/setup/remove 执行插件 setup 后不会自动重启网关；
重启服务（或下次运行 asg engines）后生效。config / secret 写入后会整栈重启一次。`;

export type SetupRunner = (options: RunPluginSetupOptions) => Promise<RunPluginSetupResult>;

export interface ExtensionsApi {
  install: typeof installExtension;
  list: typeof listExtensions;
  remove: typeof removeExtension;
  search: typeof searchExtensions;
  loadManifest: typeof loadInstalledManifest;
  setup: SetupRunner;
}

const DEFAULT_API: ExtensionsApi = {
  install: installExtension,
  list: listExtensions,
  remove: removeExtension,
  search: searchExtensions,
  loadManifest: loadInstalledManifest,
  setup: runPluginSetup,
};

let api: ExtensionsApi = DEFAULT_API;

/** 测试钩子：替换扩展后端，传 null 恢复默认。 */
export function setExtensionsApiForTests(overrides: Partial<ExtensionsApi> | null): void {
  api = { ...DEFAULT_API, ...(overrides ?? {}) };
}

type RestartFn = (root: string, reporter: Reporter) => Promise<void>;
type StdinReader = () => Promise<string>;

const defaultRestart: RestartFn = (root, reporter) => restartForConfig(root, reporter);

async function readStdinDefault(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let restart: RestartFn = defaultRestart;
let stdinReader: StdinReader = readStdinDefault;

/** 测试钩子：替换整栈重启，传 null 恢复默认。 */
export function setRestartForTests(fn: RestartFn | null): void {
  restart = fn ?? defaultRestart;
}

/** 测试钩子：替换 stdin 读取，传 null 恢复默认。 */
export function setStdinReaderForTests(fn: StdinReader | null): void {
  stdinReader = fn ?? readStdinDefault;
}

function usageError(message: string = USAGE): CliError {
  return new CliError("UNEXPECTED", EXIT.USAGE, message);
}

function usage(message: string): never {
  throw usageError(message);
}

function makeLogger(reporter: Reporter): (message: string) => void {
  return (message) => reporter.event({ event: "log", service: "extensions", message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 返回 manifest 声明的后端（0.4.0 起只有 V2 manifest）。 */
function declaredBackends(manifest: ExtensionManifest | undefined): ExtensionBackend[] {
  return manifest?.backends ?? [];
}

/** list 输出里的后端条目：manifest 声明 + `backends.json` 中的运行状态（只读文件）。 */
export interface ListedBackend extends ExtensionBackend {
  installed: boolean;
  enabled: boolean;
  version?: string;
  path?: string;
}

export interface ListedExtension extends Omit<InstalledExtension, "backends"> {
  backends: ListedBackend[];
}

/** 读取 `data/extension-data/<id>/backends.json`，不执行任何插件代码。 */
function listExtensionsWithBackends(
  root: string,
  reporter: Reporter,
): ListedExtension[] {
  return api.list(root).map((extension) => {
    const { states, warning } = readBackendStates(root, extension.id);
    if (warning) {
      reporter.info(`警告: ${extension.id} 的后端状态不可用：${warning}`);
    }

    const backends = (extension.backends ?? []).map((backend) => {
      const state = normalizeBackendState(states[backend.id]);
      // 与扩展列表保持一致：状态文件可能缺失/过期，后端目录存在即视为已安装。
      const dirInstalled = existsSync(backendInstallDir(root, extension.id, backend.id));
      const entry: ListedBackend = {
        ...backend,
        installed: state.installed || dirInstalled,
        enabled: state.enabled,
      };
      if (state.version) entry.version = state.version;
      if (state.path) entry.path = state.path;
      return entry;
    });

    return { ...extension, backends };
  });
}

function renderBackends(backends: ListedBackend[]): string {
  if (backends.length === 0) return "-";
  return backends
    .map((backend) => {
      if (!backend.installed) return `${backend.id}(未安装)`;
      return backend.version ? `${backend.id}@${backend.version}` : backend.id;
    })
    .join(",");
}

function renderIds(items: readonly { id: string }[] | undefined): string {
  return items && items.length > 0 ? items.map((item) => item.id).join(",") : "-";
}

function renderList(extensions: ListedExtension[]): string {
  const header = ["ID", "VERSION", "PROVIDES", "BACKENDS", "CHANNELS", "ENGINES", "ENTRY"];
  const rows = extensions.map((extension) => [
    extension.id,
    extension.version ?? "-",
    extension.provides && extension.provides.length > 0 ? extension.provides.join(",") : "-",
    renderBackends(extension.backends),
    renderIds(extension.fetch_channels),
    renderIds(extension.search_engines),
    extension.entry ?? "-",
  ]);

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]!.length)),
  );
  const format = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();

  const lines = [format(header), ...rows.map((row) => format(row))];
  if (extensions.length === 0) {
    lines.push("", "（未安装任何第三方插件）");
  }
  for (const extension of extensions) {
    if (extension.error) lines.push(`警告: ${extension.id} 无法读取：${extension.error}`);
  }
  return lines.join("\n");
}

function renderSearch(results: ExtensionSearchItem[]): string {
  if (results.length === 0) return "没有找到匹配的插件。";
  return results
    .map((item) => {
      const description = item.description || "（无描述）";
      return `${item.repo}  ★ ${item.stars}\n  ${description}\n  ${item.url}`;
    })
    .join("\n\n");
}

export function parseInstallTarget(value: string): { repo: string; version?: string } {
  const at = value.lastIndexOf("@");
  if (at === -1) return { repo: value };
  if (at === 0 || at === value.length - 1) {
    throw usageError(`安装目标格式应为 owner/repo[@version]：${value}`);
  }
  const repo = value.slice(0, at);
  const version = value.slice(at + 1).replace(/^[vV]/, "");
  if (!isValidExtensionVersion(version)) {
    throw usageError(`版本号不合法：${value.slice(at + 1)}（示例：1.2.3）`);
  }
  return { repo, version };
}

async function runSearch(args: string[]): Promise<CommandResult> {
  const limit = takeNumber(args, "--limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw usageError("--limit 必须是 1..100 的整数");
  }
  if (args.some((arg) => arg.startsWith("-"))) {
    throw usageError(`未知选项：${args.find((arg) => arg.startsWith("-"))}\n\n${USAGE}`);
  }

  const query = args.join(" ").trim();
  const results = await api.search({
    ...(query ? { query } : {}),
    ...(limit === undefined ? {} : { limit }),
  });
  return {
    data: { query: query || null, results },
    human: renderSearch(results),
  };
}

function withoutGlobals(args: string[]): string[] {
  return args.filter((arg) => arg !== "--json" && arg !== "--jsonl");
}

/** 取出可重复出现的 `--name value` / `--name=value`，保持书写顺序并去重。 */
function takeRepeated(rest: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rest.length; ) {
    const arg = rest[index]!;
    if (arg === name) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) usage(`${name} 需要一个后端 id`);
      values.push(value);
      rest.splice(index, 2);
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (value.length === 0) usage(`${name} 需要一个后端 id`);
      values.push(value);
      rest.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return [...new Set(values)];
}

/** 把 --backend 的请求收敛到 manifest 声明的后端；未知 id 报明确错误。 */
function selectBackends(
  id: string,
  declared: ExtensionBackend[],
  requested: string[],
): string[] {
  const ids = declared.map((backend) => backend.id);
  if (ids.length === 0) {
    if (requested.length === 0) return [];
    throw new CliError(
      "CONFIG_INVALID",
      EXIT.INVALID,
      `该插件没有声明后端：${id}（收到 --backend ${requested.join(", ")}）`,
    );
  }

  const known = new Set(ids);
  const unknown = requested.filter((item) => !known.has(item));
  if (unknown.length > 0) {
    throw new CliError(
      "CONFIG_INVALID",
      EXIT.INVALID,
      `插件 ${id} 没有声明后端：${unknown.join(", ")}（可用：${ids.join(", ")}）`,
    );
  }

  return requested.length > 0 ? requested : ids;
}

/** `install` 已落盘后才校验 --backend，错误里必须说明插件已经装上了。 */
function installedBackendHint(installedPath: string, declaredIds: string[]): string {
  const available = declaredIds.length > 0 ? declaredIds.join(", ") : "（无）";
  return `插件已安装到 ${installedPath}\n可用后端：${available}`;
}

interface SetupReport {
  attempted: boolean;
  ok: boolean;
  action: SetupAction;
  backends: string[];
  result?: unknown;
  error?: string;
}

/** 调用注入的 setup runner；插件身份/入口/schema 全部来自已安装 manifest。 */
async function runManifestSetup(
  root: string,
  reporter: Reporter,
  manifest: ExtensionManifest,
  action: SetupAction,
  backends: string[],
): Promise<SetupReport> {
  const outcome = await api.setup({
    root,
    entry: manifest.entry,
    action,
    plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
    backends,
    configSchema: manifest.config_schema,
    onLog: makeLogger(reporter),
  });

  const report: SetupReport = {
    attempted: true,
    ok: outcome.ok,
    action,
    backends,
  };
  if (outcome.result !== undefined) report.result = outcome.result;
  if (outcome.error !== undefined) report.error = outcome.error;
  return report;
}

function skippedSetup(action: SetupAction, backends: string[]): SetupReport {
  return { attempted: false, ok: true, action, backends };
}

function formatSetupResult(value: unknown): string {
  if (value === undefined) return "（无返回值）";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

async function runInstall(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const noSetup = takeFlag(args, "--no-setup");
  const requested = takeRepeated(args, "--backend");
  const positional = withoutGlobals(args);
  if (positional.length !== 1) {
    throw usageError(INSTALL_USAGE);
  }

  const target = positional[0]!;
  const { repo, version } = parseInstallTarget(target);
  if (!isValidRepo(repo)) {
    throw usageError(`仓库格式应为 owner/name：${repo}`);
  }

  const result = await api.install({
    root,
    repo,
    ...(version === undefined ? {} : { version }),
    logger: makeLogger(reporter),
  });

  const declared = result.backends ?? [];
  const backendIds = declared.map((backend) => backend.id);

  // 安装 API 不返回 manifest，无法在下载前校验 --backend；这里包装错误，
  // 明确告知插件已落盘以及可用的后端 id。
  let selected: string[];
  try {
    selected = selectBackends(result.id, declared, requested);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const wrapped = new CliError(
      error.code,
      error.exitCode,
      `${error.message}\n${installedBackendHint(result.path, backendIds)}`,
      {
        plugin_id: result.id,
        backend_ids: backendIds,
        requested_backends: requested,
        path: result.path,
        error,
        restarted: false,
      },
    );
    wrapped.cause = error;
    throw wrapped;
  }

  let setupReport: SetupReport;
  if (selected.length === 0) {
    setupReport = skippedSetup("install", []);
  } else if (noSetup) {
    setupReport = skippedSetup("install", selected);
  } else {
    const manifest = api.loadManifest(root, result.id);
    setupReport = await runManifestSetup(root, reporter, manifest, "install", selected);
    if (!setupReport.ok) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.FAIL,
        `插件 ${result.id} 的后端 setup 失败：${setupReport.error ?? "未知错误"}\n` +
          `插件已保留在 ${result.path}；可运行 \`asg extensions setup ${result.id}\` 重试。`,
        {
          plugin_id: result.id,
          backend_ids: backendIds,
          backends: selected,
          path: result.path,
          error: setupReport.error,
          restarted: false,
        },
      );
    }
  }

  const setupLine = setupReport.attempted
    ? `setup: 已完成（action=install，后端 ${setupReport.backends.join(", ")}）`
    : `setup: 已跳过${noSetup ? "（--no-setup）" : ""}`;

  return {
    data: {
      ...result,
      plugin_id: result.id,
      // backends 保留为兼容别名；backend_ids 是脚本应使用的稳定字段。
      backends: backendIds,
      backend_ids: backendIds,
      setup: setupReport,
      restarted: false,
    },
    human: [
      `已安装 ${result.name} (${result.id}) v${result.version}`,
      `能力: ${result.provides.join(", ")}`,
      `后端: ${backendIds.length > 0 ? backendIds.join(", ") : "-"}`,
      `通道: ${renderIds(result.fetch_channels)}`,
      `搜索源: ${renderIds(result.search_engines)}`,
      `路径: ${result.path}`,
      setupLine,
      "重启网关后生效。",
    ].join("\n"),
  };
}

function runList(root: string, reporter: Reporter, args: string[]): CommandResult {
  const positional = withoutGlobals(args);
  if (positional.length > 0) {
    throw usageError(`list 不接受额外参数：${positional.join(" ")}`);
  }
  const extensions = listExtensionsWithBackends(root, reporter);
  return {
    data: { extensions },
    human: renderList(extensions),
  };
}

async function runSetup(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const status = takeFlag(args, "--status");
  const uninstall = takeFlag(args, "--uninstall");
  const requested = takeRepeated(args, "--backend");
  const positional = withoutGlobals(args);

  if (status && uninstall) usage("--status 与 --uninstall 只能二选一");
  if (positional.length !== 1) usage(SETUP_USAGE);

  const id = positional[0]!;
  const manifest = api.loadManifest(root, id);
  const declared = declaredBackends(manifest);
  if (declared.length === 0) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, `该插件没有声明后端：${id}`);
  }

  const selected = selectBackends(id, declared, requested);
  const action: SetupAction = status ? "status" : uninstall ? "uninstall" : "install";
  const report = await runManifestSetup(root, reporter, manifest, action, selected);

  if (!report.ok) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.FAIL,
      `插件 ${id} 的 setup 失败（action=${action}）：${report.error ?? "未知错误"}\n` +
        `可修复后重试 \`asg extensions setup ${id}\`。`,
      { id, action, backends: selected, error: report.error },
    );
  }

  return {
    data: {
      id,
      plugin_id: id,
      action,
      // backends 保留为兼容别名；backend_ids 是脚本应使用的稳定字段。
      backends: selected,
      backend_ids: selected,
      ok: report.ok,
      result: report.result,
      setup: report,
      restarted: false,
    },
    human: [
      `已执行 ${manifest.name} (${id}) 的 setup（action=${action}）。`,
      `后端: ${selected.join(", ")}`,
      `结果: ${formatSetupResult(report.result)}`,
      "未自动重启网关；重启网关后生效。",
    ].join("\n"),
  };
}

async function runRemove(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const keepData = takeFlag(args, "--keep-data");
  const force = takeFlag(args, "--force");
  const positional = withoutGlobals(args);
  if (positional.length !== 1) {
    throw usageError(REMOVE_USAGE);
  }

  const id = positional[0]!;
  let manifest: ExtensionManifest | undefined;
  try {
    manifest = api.loadManifest(root, id);
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError("PLUGIN_FAILED", EXIT.FAIL, error instanceof Error ? error.message : String(error));

    if (cliError.code === "PLUGIN_UNKNOWN") {
      // 未安装：交给 remove 输出标准的 PLUGIN_UNKNOWN（退出码 4）。
    } else if (!force) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.INVALID,
        `无法读取插件 manifest：${cliError.message}\n处理：确认后可加 --force 跳过卸载 setup 直接删除。`,
      );
    } else {
      reporter.info(`警告: 无法读取插件 manifest，已跳过卸载 setup：${cliError.message}`);
    }
  }

  const declared = declaredBackends(manifest);
  const backendIds = declared.map((backend) => backend.id);

  let setupReport: SetupReport | null = null;
  if (!force && manifest && backendIds.length > 0) {
    setupReport = await runManifestSetup(root, reporter, manifest, "uninstall", backendIds);
    if (!setupReport.ok) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.FAIL,
        `插件 ${id} 的卸载 setup 失败：${setupReport.error ?? "未知错误"}\n` +
          `插件目录未删除；可运行 \`asg extensions setup ${id} --uninstall\` 重试，或使用 --force 直接删除。`,
        { id, backends: backendIds, error: setupReport.error },
      );
    }
  }

  const result = await api.remove(root, id);

  const dataDir = extensionDataDir(root, id);
  const hadData = existsSync(dataDir);
  if (!keepData && hadData) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message =
        `插件已卸载，但数据目录删除失败：${dataDir}（id=${result.id}）\n` +
        `原因：${reason}\n` +
        "插件目录已删除；可手动删除该数据目录，或忽略（下次安装会沿用）。";
      const cliError = new CliError("PLUGIN_FAILED", EXIT.FAIL, message, {
        plugin_id: result.id,
        id: result.id,
        path: dataDir,
        error,
        restarted: false,
      });
      cliError.cause = error;
      throw cliError;
    }
  }

  const lines = [`${result.id} 已卸载。`];
  lines.push(
    keepData
      ? "已保留插件数据（--keep-data）。"
      : hadData
        ? `已删除数据目录：data/extension-data/${result.id}`
        : "没有需要删除的插件数据。",
  );
  if (setupReport?.attempted) {
    lines.push(`后端卸载 setup: 已完成（${setupReport.backends.join(", ")}）`);
  }
  lines.push("重启网关后生效。");

  return {
    data: {
      ...result,
      plugin_id: result.id,
      // backends 保留为兼容别名；backend_ids 是脚本应使用的稳定字段。
      backends: backendIds,
      backend_ids: backendIds,
      setup: setupReport,
      data_removed: !keepData && hadData,
      restarted: false,
    },
    human: lines.join("\n"),
  };
}

interface SetOp {
  kind: "set";
  key: string;
  value: unknown;
}

interface UnsetOp {
  kind: "unset";
  key: string;
}

type ConfigOp = SetOp | UnsetOp;

interface ConfigOptions {
  get: { present: boolean; key?: string };
  ops: ConfigOp[];
  file?: string;
  describe: boolean;
}

/** 校验点号键路径：不接受空键、空段（`a..b` / `.a` / `a.`）。 */
function parseKeyPath(raw: string, label: string): string[] {
  const segments = raw.split(".");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    usage(`${label} 的键不能为空，也不能包含首尾/连续的点：${raw}`);
  }
  return segments;
}

function parseSetOp(raw: string): SetOp {
  const eq = raw.indexOf("=");
  if (eq <= 0) usage(`--set 需要 key=value 形式：${raw}`);
  const key = raw.slice(0, eq);
  parseKeyPath(key, "--set");
  return { kind: "set", key, value: parseConfigValue(raw.slice(eq + 1)) };
}

/** 解析 config 子命令的选项；支持重复的 --set / --unset，并保持书写顺序。 */
function parseConfigOptions(rest: string[]): ConfigOptions {
  const get: { present: boolean; key?: string } = { present: false };
  const ops: ConfigOp[] = [];
  let file: string | undefined;
  let describe = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;

    // --json 是全局参数（parseInvocation 会先摘掉）；直接调用 run 时同样接受。
    if (arg === "--json") continue;

    if (arg === "--describe") {
      describe = true;
      continue;
    }

    if (arg === "--get" || arg.startsWith("--get=")) {
      if (get.present) usage("--get 只能使用一次");
      get.present = true;
      if (arg.startsWith("--get=")) {
        get.key = arg.slice("--get=".length);
        if (get.key.length === 0) usage("--get 的键不能为空");
      } else {
        const next = rest[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          get.key = next;
          index += 1;
        }
      }
      if (get.key !== undefined) parseKeyPath(get.key, "--get");
      continue;
    }

    if (arg === "--set" || arg.startsWith("--set=")) {
      const raw = arg === "--set" ? rest[index + 1] : arg.slice("--set=".length);
      if (raw === undefined) usage("--set 需要 key=value 形式");
      if (arg === "--set") index += 1;
      ops.push(parseSetOp(raw));
      continue;
    }

    if (arg === "--unset" || arg.startsWith("--unset=")) {
      const raw = arg === "--unset" ? rest[index + 1] : arg.slice("--unset=".length);
      if (raw === undefined) usage("--unset 需要一个配置键");
      if (arg === "--unset") index += 1;
      parseKeyPath(raw, "--unset");
      ops.push({ kind: "unset", key: raw });
      continue;
    }

    if (arg === "--file" || arg.startsWith("--file=")) {
      if (file !== undefined) usage("--file 只能使用一次");
      const raw = arg === "--file" ? rest[index + 1] : arg.slice("--file=".length);
      if (raw === undefined || raw.length === 0) usage("--file 需要一个文件路径");
      if (arg === "--file") index += 1;
      file = raw;
      continue;
    }

    usage(`未知选项：${arg}\n\n${CONFIG_USAGE}`);
  }

  return { get, ops, ...(file === undefined ? {} : { file }), describe };
}

function assertConfigModes(options: ConfigOptions): void {
  const writing = options.ops.length > 0 || options.file !== undefined;
  if (options.file !== undefined && options.ops.length > 0) {
    usage("--file 不能与 --set / --unset 同时使用");
  }
  if (writing && options.get.present) {
    usage("--get 不能与 --set / --unset / --file 同时使用");
  }
  if (writing && options.describe) {
    usage("--describe 不能与 --set / --unset / --file 同时使用");
  }
  if (options.get.present && options.describe) {
    usage("--describe 不能与 --get 同时使用");
  }
}

/** 读取网关配置文档；文件缺失时按 NOT_INSTALLED 处理（与其他配置命令一致）。 */
function loadGatewayDocument(root: string): {
  paths: ConfigPaths;
  config: LoadedDocument;
} {
  const paths = configPaths(root);
  if (!existsSync(paths.config)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到配置文件：${paths.config}`);
  }
  return { paths, config: readYamlDocument(paths.config) };
}

/** `extensions.<id>.config` 的原始值；只接受对象或缺省。 */
function readRawConfig(
  config: LoadedDocument,
  id: string,
): Record<string, unknown> | undefined {
  const raw = getYamlPath(config.doc, ["extensions", id, "config"]);
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, `extensions.${id}.config 必须是对象`);
  }
  return raw;
}

function digPlain(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setDeep(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (isPlainObject(next)) {
      current = next;
      continue;
    }
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
      continue;
    }
    throw new CliError(
      "CONFIG_INVALID",
      EXIT.INVALID,
      `配置键 ${path.join(".")} 的父级 ${segment} 不是对象`,
    );
  }
  current[path[path.length - 1]!] = value;
}

/** 删除嵌套键，并向上清理变空的父对象（候选对象本身保留）。 */
function unsetDeep(target: Record<string, unknown>, path: readonly string[]): boolean {
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current: Record<string, unknown> = target;

  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isPlainObject(next)) return false;
    parents.push({ parent: current, key: segment });
    current = next;
  }

  const leaf = path[path.length - 1]!;
  const existed = Object.hasOwn(current, leaf);
  delete current[leaf];

  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const { parent, key } = parents[index]!;
    const child = parent[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete parent[key];
      continue;
    }
    break;
  }

  return existed;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "undefined";
}

function formatDefault(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
}

function renderConfigFields(fields: ConfigFieldInfo[]): string {
  if (fields.length === 0) return "config_schema 没有声明任何顶层字段。";

  const rows = fields.map((field) => [
    field.key,
    field.type,
    field.required
      ? "必填"
      : field.default === undefined
        ? "-"
        : `默认 ${formatDefault(field.default)}`,
    field.description ?? "",
  ]);

  const widths = [0, 1, 2].map((index) =>
    Math.max(...rows.map((row) => row[index]!.length)),
  );
  return rows
    .map((row) =>
      `${row[0]!.padEnd(widths[0]!)}  ${row[1]!.padEnd(widths[1]!)}  ${row[2]!.padEnd(widths[2]!)}  ${row[3]!}`.trimEnd(),
    )
    .join("\n");
}

function runConfigDescribe(id: string, manifest: ExtensionManifest): CommandResult {
  if (manifest.config_schema === undefined) {
    return {
      data: { id, fields: [] },
      human: "未声明 config_schema，配置会原样透传。",
    };
  }
  const fields = describePluginConfig(manifest.config_schema);
  return {
    data: { id, fields },
    human: renderConfigFields(fields),
  };
}

function runConfigRead(
  id: string,
  manifest: ExtensionManifest,
  raw: Record<string, unknown> | undefined,
  get: ConfigOptions["get"],
): CommandResult {
  const resolved = resolvePluginConfig(manifest.config_schema, raw);

  const config: PluginConfig = resolved.ok ? resolved.value : (raw ?? {});
  const data: Record<string, unknown> = resolved.ok
    ? { id, config, valid: true }
    : { id, config, valid: false, error: resolved.error };

  if (get.key !== undefined) {
    const value = digPlain(config, get.key.split("."));
    if (value === undefined) {
      throw new CliError("CONFIG_INVALID", EXIT.INVALID, `配置中没有该路径：${get.key}`);
    }
    return {
      data: { ...data, key: get.key, value },
      human: `${get.key}: ${formatValue(value)}`,
    };
  }

  const text = JSON.stringify(config, null, 2);
  return {
    data,
    human: resolved.ok ? text : `配置未通过校验：${resolved.error}\n${text}`,
  };
}

async function runConfigWrite(
  root: string,
  reporter: Reporter,
  id: string,
  manifest: ExtensionManifest,
  paths: ConfigPaths,
  config: LoadedDocument,
  raw: Record<string, unknown> | undefined,
  options: ConfigOptions,
): Promise<CommandResult> {
  let candidate: Record<string, unknown>;
  const changed = new Set<string>();

  if (options.file !== undefined) {
    if (!existsSync(options.file)) {
      throw new CliError("CONFIG_INVALID", EXIT.INVALID, `未找到配置文件：${options.file}`);
    }
    // YAML 解析器同时接受 JSON（JSON 是 YAML 的子集）；根必须是对象。
    candidate = documentToPlain(readYamlDocument(options.file).doc);
    changed.add(`extensions.${id}.config`);
  } else {
    candidate = structuredClone(raw ?? {});
    for (const op of options.ops) {
      if (op.kind === "set") {
        const keyPath = op.key.split(".");
        const before = digPlain(candidate, keyPath);
        setDeep(candidate, keyPath, op.value);
        // 只有值真正变化才算 changed，方便脚本判断是否需要后续动作。
        if (JSON.stringify(before) !== JSON.stringify(op.value)) {
          changed.add(`extensions.${id}.config.${op.key}`);
        }
      } else if (unsetDeep(candidate, op.key.split("."))) {
        changed.add(`extensions.${id}.config.${op.key}`);
      }
    }
  }

  // 校验失败 → CONFIG_INVALID，目标文件保持原样。
  const resolved = resolvePluginConfig(manifest.config_schema, candidate);
  if (!resolved.ok) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, resolved.error);
  }

  const configPath = ["extensions", id, "config"] as const;
  if (Object.keys(candidate).length === 0) {
    // deleteYamlPath 会继续清理空的 extensions.<id>，但保留顶层 extensions。
    deleteYamlPath(config.doc, configPath);
  } else {
    setYamlPath(config.doc, configPath, candidate);
  }

  const configText = documentToText(config.doc);
  const secrets = readYamlDocument(paths.secrets);
  const { warnings } = validateConfigTexts({
    configText,
    secretsText: secrets.exists ? secrets.text : undefined,
  });
  for (const warning of warnings) reporter.info(`警告: ${warning}`);

  writeConfigFile(paths.config, configText);
  await restart(root, reporter);

  return {
    data: {
      id,
      config: resolved.value,
      changed: [...changed],
      restart: "all",
      restarted: true,
    },
    human: [
      `已更新扩展 ${id} 的配置。`,
      "服务已整栈重启并通过健康检查。",
      RESTART_NOTICE,
    ].join("\n"),
  };
}

async function runConfig(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const [idRaw, ...rest] = args;
  if (idRaw === undefined || idRaw.startsWith("-")) usage(CONFIG_USAGE);

  const id = idRaw;
  const options = parseConfigOptions(rest);
  assertConfigModes(options);

  const manifest = loadInstalledManifest(root, id);
  const { paths, config } = loadGatewayDocument(root);
  const raw = readRawConfig(config, id);

  if (options.describe) return runConfigDescribe(id, manifest);
  if (options.ops.length > 0 || options.file !== undefined) {
    return runConfigWrite(root, reporter, id, manifest, paths, config, raw, options);
  }
  return runConfigRead(id, manifest, raw, options.get);
}

async function runSecret(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const [idRaw, ...rest] = args;
  if (idRaw === undefined || idRaw.startsWith("-")) usage(SECRET_USAGE);

  const id = idRaw;
  const stdin = takeFlag(rest, "--stdin");
  const clear = takeFlag(rest, "--clear");
  const name = takeValue(rest, "--name");

  if (stdin && clear) usage("--stdin 与 --clear 只能二选一");
  if (!stdin && !clear) usage("需要 --stdin（从标准输入读取密钥）或 --clear");
  if (name === undefined) usage("必须用 --name 指定密钥名");
  if (!EXTENSION_SECRET_NAME.test(name)) {
    usage(`密钥名不合法：${name}（要求 [a-z][a-z0-9_-]*）`);
  }
  if (rest.length > 0) usage(SECRET_USAGE);

  // 与 config 一致：id 必须指向已安装插件（manifest 损坏也算插件错误）。
  loadInstalledManifest(root, id);

  const paths = configPaths(root);
  if (!existsSync(paths.config)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到配置文件：${paths.config}`);
  }
  const config = readYamlDocument(paths.config);
  const secrets = readYamlDocument(paths.secrets);

  const display = `secrets.extensions.${id}.${name}`;
  const secretPath = ["extensions", id, name] as const;

  let text: string | undefined;
  if (clear) {
    if (deleteYamlPath(secrets.doc, secretPath)) {
      text = documentToText(secrets.doc);
    }
  } else {
    const value = (await stdinReader()).replace(/\r?\n$/, "");
    if (value.trim().length === 0) {
      usage("密钥不能为空；如需删除请使用 --clear");
    }
    setYamlPath(secrets.doc, secretPath, value);
    text = documentToText(secrets.doc);
  }

  if (text !== undefined) {
    // secrets.yaml 一律 0600，避免密钥对 group/other 可读。
    const { warnings } = validateConfigTexts({
      configText: documentToText(config.doc),
      secretsText: text,
    });
    for (const warning of warnings) reporter.info(`警告: ${warning}`);
    writeConfigFile(paths.secrets, text, 0o600);
  }

  await restart(root, reporter);

  return {
    data: {
      id,
      name,
      changed: text === undefined ? [] : [display],
      restart: "all",
      restarted: true,
    },
    human: clear ? `已删除密钥: ${display}` : `已更新密钥: ${display}`,
  };
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [subcommand, ...args] = rest;

  switch (subcommand) {
    case "search":
      return runSearch(args);
    case "install":
      return runInstall(root, reporter, args);
    case "setup":
      return runSetup(root, reporter, args);
    case "list":
      return runList(root, reporter, args);
    case "remove":
      return runRemove(root, reporter, args);
    case "config":
      return runConfig(root, reporter, args);
    case "secret":
      return runSecret(root, reporter, args);
    case "-h":
    case "--help":
      return { data: { usage: USAGE }, human: USAGE };
    case undefined:
      throw usageError(USAGE);
    default:
      throw usageError(
        `未知 extensions 子命令：${subcommand}（可用: search | install | setup | list | remove | config | secret）`,
      );
  }
};
