#!/usr/bin/env node
/**
 * agent_search_gateway 0.3.x 临时升级/迁移脚本（P1）
 *
 * 目标：把 0.3.x 官方插件分段升级到兼容版本，并让插件安装自己的后端。
 * 五个阶段：preflight -> plugins -> backends -> config -> restart。
 * config 阶段把平台配置/密钥迁到 extensions.<plugin-id>，供 V2 插件读取。
 * 0.4.x 起删除本目录。
 *
 * 设计约束：
 *   - 纯 Node ESM，不引入依赖；
 *   - 默认通过 process.execPath 执行 <root>/bin/asg.mjs，可注入 runner；
 *   - 所有写入可断点续跑（state.json 原子写），可 dry-run，可回滚；
 *   - 不删除 data/extension-data 与 data/backends。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = "0.3.x";
const STATE_SCHEMA = 1;
const CHECKLIST_SCHEMA = 1;
const MIN_NODE_MAJOR = 20;
const PHASES = ["preflight", "plugins", "backends", "config", "restart"];
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 500;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_CHECKLIST = path.join(HERE, "0.3.x.plugins.json");

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

const USAGE = `用法: node scripts/migrations/0.3.x.mjs [选项]

0.3.x 临时迁移脚本：分阶段升级官方插件、安装插件后端并迁移平台配置。
阶段：preflight -> plugins -> backends -> config -> restart。

选项:
  --root <dir>              安装根；缺省从脚本位置向上查找 gateway.yaml / data/current*
  --phase <name>            preflight|plugins|backends|config|restart|all（默认 all）
  --dry-run                 只做 preflight 计划，不备份、不写 state、不执行命令
  --resume                  从 state.json 中第一个未完成阶段继续
  --rollback                恢复配置备份并按记录回滚插件版本
  --rollback-on-failure     任一阶段失败后自动回滚
  --continue-on-error       plugins / backends 阶段单个插件失败后继续
  --plugin <id>=<repo>@<ver>
                            覆盖或新增一个迁移目标（可重复）；只处理已安装插件
  --no-restart              restart 阶段跳过
  --jsonl                   所有日志输出为 NDJSON 事件，最后一行为 result
  -h, --help                显示本帮助

文件位置:
  state:    <root>/data/migrations/0.3.x/state.json
  backups:  <root>/data/migrations/0.3.x/backup-<时间>/
  清单:     scripts/migrations/0.3.x.plugins.json
            （可用环境变量 ASG_MIGRATION_MANIFEST 覆盖，供测试/应急使用）
  超时:     ASG_MIGRATION_COMMAND_TIMEOUT_MS 可覆盖单条 asg 命令的超时（毫秒，默认 30 分钟）
`;

// ---------------------------------------------------------------------------
// 错误与通用工具
// ---------------------------------------------------------------------------

/** 带退出码的迁移错误（2 = 用法错误，1 = 运行错误）。 */
export class MigrationError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "MigrationError";
    this.exitCode = exitCode;
  }
}

function usageError(message) {
  return new MigrationError(message, 2);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 读取正整数环境变量；非法值返回 null。 */
function positiveIntEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function commandTimeoutFrom(overrides = {}) {
  const injected = Number(overrides.commandTimeoutMs);
  if (Number.isFinite(injected) && injected > 0) return Math.floor(injected);
  return positiveIntEnv("ASG_MIGRATION_COMMAND_TIMEOUT_MS") ?? DEFAULT_COMMAND_TIMEOUT_MS;
}

function nowIso() {
  return new Date().toISOString();
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function existsSync(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLastJson(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // 继续向前找：CLI 可能先输出事件行。
    }
  }
  return null;
}

function tail(text, max = 1500) {
  const value = String(text ?? "").trim();
  if (!value) return "";
  return value.length > max ? `…${value.slice(-max)}` : value;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 文件不存在时的默认权限：配置文件 0644，密钥文件 0600。 */
const DEFAULT_FILE_MODES = {
  "gateway.yaml": 0o644,
  "secrets.yaml": 0o600,
};
const FALLBACK_FILE_MODE = 0o644;

/** 迁移写回 secrets.yaml 时的强制权限（安全优先，避免 group/other 可读）。 */
const SECRETS_FILE_MODE = 0o600;

function defaultModeFor(file) {
  return DEFAULT_FILE_MODES[path.basename(file)] ?? FALLBACK_FILE_MODE;
}

/**
 * 原子写入文本：
 *   - 目标已存在时保留其原有权限（避免 600 -> 644）；
 *   - 目标不存在时按文件名取默认权限（gateway.yaml 0644 / secrets.yaml 0600）；
 *   - 可通过 options.mode 显式覆盖（如 config 阶段强制 secrets.yaml 为 0600）。
 */
async function writeTextAtomic(file, text, options = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });

  let mode = options.mode;
  if (mode === undefined) {
    let originalMode = null;
    try {
      originalMode = (await fsp.stat(file)).mode & 0o777;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    mode = originalMode ?? defaultModeFor(file);
  }

  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.writeFile(temp, text, "utf8");
    // rename 会带走临时文件的权限，所以必须在 rename 之前设定。
    await fsp.chmod(temp, mode);
    try {
      await fsp.rename(temp, file);
    } catch {
      // Windows 上 rename 不能覆盖已存在文件。
      await fsp.rm(file, { force: true });
      await fsp.rename(temp, file);
    }
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 解析命令行；未知参数抛用法错误。 */
export function parseArgs(argv = []) {
  const opts = {
    root: null,
    phase: "all",
    dryRun: false,
    resume: false,
    rollback: false,
    rollbackOnFailure: false,
    continueOnError: false,
    plugins: [],
    noRestart: false,
    jsonl: false,
    help: false,
  };

  const takeValue = (arg, name, argvRef, indexRef) => {
    if (arg === name) {
      const value = argvRef[(indexRef.i += 1)];
      if (value === undefined || value.startsWith("-")) {
        throw usageError(`${name} 需要一个值`);
      }
      return value;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (!value) throw usageError(`${name} 需要一个值`);
      return value;
    }
    return undefined;
  };

  const ref = { i: 0 };
  for (; ref.i < argv.length; ref.i += 1) {
    const arg = argv[ref.i];

    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--resume") {
      opts.resume = true;
      continue;
    }
    if (arg === "--rollback") {
      opts.rollback = true;
      continue;
    }
    if (arg === "--rollback-on-failure") {
      opts.rollbackOnFailure = true;
      continue;
    }
    if (arg === "--continue-on-error") {
      opts.continueOnError = true;
      continue;
    }
    if (arg === "--no-restart") {
      opts.noRestart = true;
      continue;
    }
    if (arg === "--jsonl") {
      opts.jsonl = true;
      continue;
    }

    let value = takeValue(arg, "--root", argv, ref);
    if (value !== undefined) {
      opts.root = value;
      continue;
    }
    value = takeValue(arg, "--phase", argv, ref);
    if (value !== undefined) {
      if (!["all", ...PHASES].includes(value)) {
        throw usageError(`未知阶段：${value}（可选：all|${PHASES.join("|")}）`);
      }
      opts.phase = value;
      continue;
    }
    value = takeValue(arg, "--plugin", argv, ref);
    if (value !== undefined) {
      opts.plugins.push(value);
      continue;
    }

    throw usageError(`未知参数：${arg}`);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// 根解析与清单
// ---------------------------------------------------------------------------

/** 根解析：--root > 从脚本位置向上找 gateway.yaml > data/current* > cwd。 */
export function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);

  let current = path.resolve(HERE);
  for (;;) {
    if (
      existsSync(path.join(current, "gateway.yaml")) ||
      existsSync(path.join(current, "data", "current.json")) ||
      existsSync(path.join(current, "data", "current"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function validateTarget(entry, source) {
  if (!isPlainObject(entry)) {
    throw new MigrationError(`${source} 中的插件条目必须是对象`, 1);
  }
  const { id, repo, version } = entry;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new MigrationError(`${source} 中的插件 id 不合法：${String(id)}`, 1);
  }
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    throw new MigrationError(`${source} 中 ${id} 的 repo 不合法：${String(repo)}`, 1);
  }
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    throw new MigrationError(`${source} 中 ${id} 的 version 不合法：${String(version)}`, 1);
  }
  return { id, repo, version };
}

/** 读取并校验 0.3.x.plugins.json。 */
export async function readChecklist(file) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new MigrationError(
        `未找到迁移清单：${file}\n处理：确认 scripts/migrations/0.3.x.plugins.json 存在，或用 --plugin 显式指定目标（仍需清单）。`,
        1,
      );
    }
    throw new MigrationError(`无法读取迁移清单 ${file}：${messageOf(error)}`, 1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new MigrationError(`迁移清单不是合法 JSON：${file}（${messageOf(error)}）`, 1);
  }
  if (!isPlainObject(data)) {
    throw new MigrationError(`迁移清单必须是对象：${file}`, 1);
  }
  if (data.schema !== CHECKLIST_SCHEMA) {
    throw new MigrationError(
      `迁移清单 schema 必须是 ${CHECKLIST_SCHEMA}，收到：${String(data.schema)}`,
      1,
    );
  }
  if (!Array.isArray(data.plugins)) {
    throw new MigrationError("迁移清单缺少 plugins 数组", 1);
  }

  const seen = new Set();
  const plugins = data.plugins.map((entry, index) => {
    const target = validateTarget(entry, `迁移清单 plugins[${index}]`);
    if (seen.has(target.id)) {
      throw new MigrationError(`迁移清单中插件 id 重复：${target.id}`, 1);
    }
    seen.add(target.id);
    return target;
  });
  return { path: file, schema: data.schema, plugins };
}

/** 解析 --plugin <id>=<repo>@<version>，返回按 id 索引的覆盖表。 */
export function parsePluginOverrides(values = []) {
  const overrides = new Map();
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0 || eq === raw.length - 1) {
      throw usageError(`--plugin 格式应为 <id>=<repo>@<version>：${raw}`);
    }
    const id = raw.slice(0, eq);
    const target = raw.slice(eq + 1);
    const at = target.lastIndexOf("@");
    if (at <= 0 || at === target.length - 1) {
      throw usageError(`--plugin 的版本格式应为 <repo>@<version>：${raw}`);
    }
    const repo = target.slice(0, at);
    const version = target.slice(at + 1).replace(/^[vV]/, "");
    if (!ID_RE.test(id)) throw usageError(`--plugin 的插件 id 不合法：${id}`);
    if (!REPO_RE.test(repo)) throw usageError(`--plugin 的 repo 不合法：${repo}`);
    if (!VERSION_RE.test(version)) throw usageError(`--plugin 的 version 不合法：${version}`);
    overrides.set(id, { id, repo, version });
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// 已安装插件扫描
// ---------------------------------------------------------------------------

function normalizeBackends(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item !== null && item !== undefined);
}

const MANIFEST_NAMES = ["asg-extension.json", "asg-plugin.json"];

/** 扫描 data/extensions/<dir> 的 V2 / V1 manifest；坏包只标记该条。 */
export async function scanInstalledExtensions(root) {
  const base = path.join(root, "data", "extensions");
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new MigrationError(`无法读取扩展目录 ${base}：${messageOf(error)}`, 1);
  }

  const installed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(base, entry.name);
    const manifestName = MANIFEST_NAMES.find((name) => existsSync(path.join(dir, name)));
    const manifestPath = manifestName ? path.join(dir, manifestName) : null;
    const item = {
      id: entry.name,
      dirName: entry.name,
      path: dir,
      version: null,
      api_version: null,
      backends: [],
      error: null,
    };

    if (!manifestPath) {
      item.error = `未找到 ${MANIFEST_NAMES.join(" 或 ")}`;
      installed.push(item);
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    } catch (error) {
      item.error =
        error?.code === "ENOENT"
          ? `未找到 ${MANIFEST_NAMES.join(" 或 ")}`
          : `无法读取 ${manifestName}：${messageOf(error)}`;
      installed.push(item);
      continue;
    }

    if (!isPlainObject(manifest)) {
      item.error = `${manifestName} 不是对象`;
      installed.push(item);
      continue;
    }
    if (typeof manifest.id === "string" && manifest.id) item.id = manifest.id;
    if (typeof manifest.version === "string" && manifest.version) {
      item.version = manifest.version;
    }
    if (manifest.api_version !== undefined) item.api_version = manifest.api_version;
    item.backends = normalizeBackends(manifest.backends);
    if (item.id !== entry.name) {
      item.error = `目录名 ${entry.name} 与 manifest.id ${item.id} 不一致`;
    }
    installed.push(item);
  }

  installed.sort((a, b) => a.id.localeCompare(b.id));
  return installed;
}

export function findInstalled(installed, id) {
  return installed.find((item) => item.id === id || item.dirName === id) ?? null;
}

/** 合并清单与 --plugin 覆盖，并标记哪些已安装 / 哪些是第三方。 */
export function buildTargets(checklistPlugins, overrides, installed) {
  const merged = new Map();
  for (const plugin of checklistPlugins) merged.set(plugin.id, plugin);
  for (const [id, plugin] of overrides) merged.set(id, plugin);

  const targets = [];
  for (const plugin of merged.values()) {
    const item = findInstalled(installed, plugin.id);
    targets.push({
      id: plugin.id,
      repo: plugin.repo,
      version: plugin.version,
      installed: Boolean(item),
      missing: !item,
      from: item?.version ?? null,
      backends: item?.backends ?? [],
      manifestError: item?.error ?? null,
    });
  }
  targets.sort((a, b) => a.id.localeCompare(b.id));

  const targetIds = new Set(targets.map((target) => target.id));
  const thirdParty = installed.filter(
    (item) => !targetIds.has(item.id) && !targetIds.has(item.dirName),
  );
  return { targets, thirdParty };
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

function initialState(root, checklistPath) {
  return {
    schema: STATE_SCHEMA,
    migration: MIGRATION,
    root,
    created_at: nowIso(),
    updated_at: nowIso(),
    checklist: { path: checklistPath, schema: null, count: 0 },
    backup: {
      dir: null,
      created_at: null,
      gateway_yaml: null,
      secrets_yaml: null,
      gateway_existed: false,
      secrets_existed: false,
    },
    installed_before: [],
    phases: Object.fromEntries(PHASES.map((phase) => [phase, { status: "pending" }])),
    plugins: {},
    backends: {},
    errors: [],
    rollback: null,
  };
}

async function loadState(file, expectedRoot = null) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new MigrationError(`无法读取迁移状态 ${file}：${messageOf(error)}`, 1);
  }

  let state;
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new MigrationError(
      `迁移状态不是合法 JSON：${file}（${messageOf(error)}）\n处理：检查文件或删除后重新运行 preflight。`,
      1,
    );
  }
  if (!isPlainObject(state)) {
    throw new MigrationError(`迁移状态必须是对象：${file}`, 1);
  }
  if (state.schema !== STATE_SCHEMA) {
    throw new MigrationError(
      `迁移状态 schema 不匹配：期望 ${STATE_SCHEMA}，实际 ${String(state.schema)}（${file}）` +
        `\n处理：该 state 由不兼容的迁移脚本生成；确认后删除 state.json 并重新运行 preflight。`,
      1,
    );
  }
  if (state.migration !== MIGRATION) {
    throw new MigrationError(
      `迁移状态 migration 不匹配：期望 ${MIGRATION}，实际 ${String(state.migration)}（${file}）` +
        `\n处理：state.json 属于其他迁移版本；请使用对应的迁移脚本，或删除后重新运行 preflight。`,
      1,
    );
  }
  if (state.root && expectedRoot) {
    const stored = path.resolve(String(state.root));
    const current = path.resolve(expectedRoot);
    if (stored !== current) {
      throw new MigrationError(
        `迁移状态 root 与当前安装根不一致：state 记录 ${stored}，当前 ${current}（${file}）` +
          `\n处理：不要跨安装根复用 state.json；如确认当前根正确，请删除该 state.json 后重新运行 preflight。`,
        1,
      );
    }
  }
  if (!isPlainObject(state.phases)) state.phases = {};
  for (const phase of PHASES) {
    if (!isPlainObject(state.phases[phase])) state.phases[phase] = { status: "pending" };
  }
  if (!isPlainObject(state.plugins)) state.plugins = {};
  if (!isPlainObject(state.backends)) state.backends = {};
  if (!Array.isArray(state.errors)) state.errors = [];
  return state;
}

async function saveState(ctx) {
  if (!ctx.state || !ctx.stateFile) return;
  ctx.state.updated_at = nowIso();
  await writeJsonAtomic(ctx.stateFile, ctx.state);
}

function recordTargets(state, targets) {
  for (const target of targets) {
    if (target.missing) {
      if (!state.plugins[target.id]) {
        state.plugins[target.id] = {
          id: target.id,
          repo: target.repo,
          from: null,
          to: target.version,
          status: "skipped",
          reason: "未安装",
        };
      }
      continue;
    }
    const existing = state.plugins[target.id];
    if (existing) {
      existing.repo = target.repo;
      existing.to = target.version;
      if (existing.from === undefined || existing.from === null) {
        existing.from = target.from;
      }
      if (!existing.status) existing.status = "pending";
      continue;
    }
    state.plugins[target.id] = {
      id: target.id,
      repo: target.repo,
      from: target.from,
      to: target.version,
      status: "pending",
    };
  }
}

function firstIncompletePhase(state) {
  for (const phase of PHASES) {
    const status = state.phases?.[phase]?.status;
    if (status !== "done" && status !== "skipped") return phase;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/** 人类日志或 NDJSON 事件。jsonl 下所有内容都走 stdout 的 NDJSON。 */
export function createReporter(jsonl) {
  const writeJson = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  return {
    jsonl,
    log(message, level = "info", extra = {}) {
      if (jsonl) {
        writeJson({ type: "event", event: "log", level, message, ...extra });
        return;
      }
      const prefix = level === "warn" ? "警告: " : level === "error" ? "错误: " : "";
      const line = `[migrate ${MIGRATION}] ${prefix}${message}`;
      if (level === "warn" || level === "error") process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    },
    result(data) {
      if (jsonl) {
        writeJson({ type: "result", ...data });
        return;
      }
      process.stdout.write(`[migrate ${MIGRATION}] ${data.ok ? "完成" : "失败"}\n`);
      if (data.phases) {
        const parts = PHASES.map((phase) => `${phase}=${data.phases[phase] ?? "pending"}`);
        process.stdout.write(`  阶段: ${parts.join(" ")}\n`);
      }
      if (data.error) process.stdout.write(`  错误: ${data.error}\n`);
      if (data.state_file) process.stdout.write(`  state: ${data.state_file}\n`);
      if (data.backup_dir) process.stdout.write(`  备份: ${data.backup_dir}\n`);
      if (data.rollback) {
        process.stdout.write(`  回滚: ${data.rollback.status}（配置 + 插件版本）\n`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

/** 收集子进程输出，只保留最后 maxBytes 字节，避免内存无上限增长。 */
function createCapture(maxBytes = MAX_CAPTURE_BYTES) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      bytes += buffer.length;
      while (bytes > maxBytes && chunks.length > 0) {
        const first = chunks[0];
        const excess = bytes - maxBytes;
        truncated = true;
        if (first.length <= excess) {
          chunks.shift();
          bytes -= first.length;
        } else {
          chunks[0] = first.subarray(excess);
          bytes -= excess;
        }
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

/** 超时时终止整棵进程树：POSIX 用进程组，Windows 用 taskkill /T /F。 */
function killProcessTree(child) {
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
    } catch {
      // 回退到 child.kill。
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出。
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已退出。
    }
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出。
      }
    }
  }, 2000);
  escalate.unref?.();
}

/** 默认 runner：node <root>/bin/asg.mjs ...，cwd = root；带超时与输出上限。 */
export function createCommandRunner(options = {}) {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBytes = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;

  return async ({ command, args, cwd, env, timeoutMs }) =>
    await new Promise((resolve, reject) => {
      const limit =
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
      let child;
      try {
        child = spawn(command, args, {
          cwd,
          env: env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        reject(error);
        return;
      }

      const stdout = createCapture(maxBytes);
      const stderr = createCapture(maxBytes);
      let settled = false;
      let timedOut = false;
      let forceTimer;
      let killTimer;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(forceTimer);
        resolve(payload);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(forceTimer);
        reject(error);
      };
      const snapshot = (status, signal) => ({
        status,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        timedOut,
      });

      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", fail);
      child.on("close", (status, signal) => {
        if (timedOut) {
          const detail = tail(stderr.text()) || tail(stdout.text());
          fail(
            new MigrationError(
              `命令超时（${limit}ms）：${command} ${args.join(" ")}（已终止进程树）` +
                `${detail ? `\n${detail}` : ""}`,
              1,
            ),
          );
          return;
        }
        finish(snapshot(status, signal));
      });

      killTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        // 极端情况下关闭事件可能丢失：兜底以超时错误结束。
        forceTimer = setTimeout(() => {
          const detail = tail(stderr.text()) || tail(stdout.text());
          fail(
            new MigrationError(
              `命令超时（${limit}ms）：${command} ${args.join(" ")}（已终止进程树）` +
                `${detail ? `\n${detail}` : ""}`,
              1,
            ),
          );
        }, 5000);
        forceTimer.unref?.();
      }, limit);
    });
}

async function runAsg(ctx, args) {
  const cli = path.join(ctx.root, "bin", "asg.mjs");
  const timeoutMs =
    Number.isFinite(ctx.commandTimeoutMs) && ctx.commandTimeoutMs > 0
      ? ctx.commandTimeoutMs
      : DEFAULT_COMMAND_TIMEOUT_MS;
  ctx.out.log(`执行: node ${path.relative(ctx.root, cli) || cli} ${args.join(" ")}`, "info", {
    phase: ctx.currentPhase,
  });

  const pending = ctx.runner({
    command: ctx.execPath,
    args: [cli, ...args],
    cwd: ctx.root,
    env: ctx.env,
    timeoutMs,
  });

  // 注入的 runner 可能忽略 timeoutMs，这里再加一层兜底，保证 runAsg 一定不会无限等待。
  let guard;
  const deadline = new Promise((_, reject) => {
    guard = setTimeout(() => {
      reject(
        new MigrationError(
          `命令超时（${timeoutMs}ms）：asg ${args.join(" ")}（已终止进程树）` +
            `\n处理：检查网关日志与 asg status；可用 --resume 从当前阶段继续。`,
          1,
        ),
      );
    }, timeoutMs + 1000);
  });

  let result;
  try {
    result = await Promise.race([pending, deadline]);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError(`无法执行 bin/asg.mjs：${messageOf(error)}`, 1);
  } finally {
    clearTimeout(guard);
  }

  if (result?.timedOut) {
    throw new MigrationError(
      `命令超时（${timeoutMs}ms）：asg ${args.join(" ")}（已终止进程树）` +
        `\n处理：检查网关日志与 asg status；可用 --resume 从当前阶段继续。`,
      1,
    );
  }

  for (const line of String(result?.stdout ?? "").split(/\r?\n/)) {
    if (line.trim()) ctx.out.log(`  ${line}`, "child", { phase: ctx.currentPhase });
  }
  for (const line of String(result?.stderr ?? "").split(/\r?\n/)) {
    // CLI 的进度日志默认走 stderr；成功时不能当成警告，只有失败汇总才升级为 error。
    if (line.trim()) ctx.out.log(`  ${line}`, "child", { phase: ctx.currentPhase });
  }

  const status = result?.status ?? result?.exitCode ?? 1;
  if (status !== 0) {
    const detail = tail(result?.stderr) || tail(result?.stdout);
    const code = result?.signal ? `信号 ${result.signal}` : `退出码 ${status}`;
    throw new MigrationError(
      `命令失败（${code}）：asg ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
      1,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// 上下文与计划
// ---------------------------------------------------------------------------

function checkNodeVersion() {
  const major = Number(String(process.versions.node).split(".")[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new MigrationError(
      `Node.js 版本过低：当前 ${process.versions.node}，至少需要 ${MIN_NODE_MAJOR}.x`,
      1,
    );
  }
}

async function prepareContext(ctx) {
  checkNodeVersion();

  const checklist = await readChecklist(ctx.checklistPath);
  const overrides = parsePluginOverrides(ctx.opts.plugins);
  const installed = await scanInstalledExtensions(ctx.root);
  const { targets, thirdParty } = buildTargets(checklist.plugins, overrides, installed);

  ctx.checklist = checklist;
  ctx.installed = installed;
  ctx.targets = targets;
  ctx.thirdParty = thirdParty;

  for (const item of thirdParty) {
    ctx.out.log(
      `跳过第三方插件 ${item.id}${item.version ? ` ${item.version}` : ""}（不在迁移清单）`,
      "warn",
      { plugin: item.id },
    );
  }
  for (const target of targets) {
    if (target.missing) {
      ctx.out.log(`清单插件 ${target.id} 未安装，跳过（不擅自安装）`, "warn", {
        plugin: target.id,
      });
    } else if (target.manifestError) {
      ctx.out.log(`插件 ${target.id} 的 manifest 有问题：${target.manifestError}`, "warn", {
        plugin: target.id,
      });
    }
  }

  if (ctx.state) recordTargets(ctx.state, targets);

  if (targets.length === 0) {
    ctx.out.log("迁移清单为空：没有可处理的目标，restart 阶段将跳过（不重启网关）", "warn");
  } else if (targets.every((target) => target.missing)) {
    ctx.out.log(
      "清单中的插件均未安装：没有可处理的目标，restart 阶段将跳过（不重启网关）",
      "warn",
    );
  }
  return ctx;
}

/** 是否存在“实际需要处理”的目标（至少一个已安装插件）。 */
function hasActionableTargets(ctx) {
  return Array.isArray(ctx.targets) && ctx.targets.some((target) => !target.missing);
}

function backendNames(backends) {
  return backends.map((item) => {
    if (typeof item === "string") return item;
    if (isPlainObject(item) && typeof item.id === "string") return item.id;
    return "(未命名)";
  });
}

function logPlan(ctx, { dryRun }) {
  const { out, root, opts } = ctx;
  out.log(`安装根: ${root}`);
  out.log(`迁移清单: ${ctx.checklistPath}（${ctx.checklist.plugins.length} 条）`);
  out.log(`已安装插件: ${ctx.installed.length} 个`);

  if (ctx.targets.length === 0) {
    out.log("目标插件: 无（清单为空）");
  } else {
    out.log("目标插件:");
    for (const target of ctx.targets) {
      if (target.missing) {
        out.log(`  - ${target.id}: 未安装，跳过（清单 ${target.version}）`, "warn");
        continue;
      }
      const from = target.from ?? "未知版本";
      const action = target.from === target.version ? "版本一致" : "升级";
      const backends =
        target.backends.length > 0
          ? `，后端 ${backendNames(target.backends).join(",")}`
          : "，无后端声明";
      out.log(`  - ${target.id}: ${from} -> ${target.version}（${action}${backends}）`);
    }
  }

  const phaseText = opts.phase === "all" ? PHASES.join(" -> ") : opts.phase;
  out.log(`计划阶段: ${phaseText}`);
  if (dryRun) {
    const plannedBackup = path.join(
      root,
      "data",
      "migrations",
      MIGRATION,
      `backup-${timestamp()}`,
    );
    out.log(`备份位置（dry-run 不创建）: ${plannedBackup}`);
    out.log("dry-run：仅执行 preflight 计划，不备份、不写 state、不执行任何命令");
  }
}

// ---------------------------------------------------------------------------
// 阶段实现
// ---------------------------------------------------------------------------

async function backupConfigs(ctx) {
  const { state, root, out } = ctx;

  // 复用已有备份：重复 preflight / --resume 时不能覆盖 P2 配置迁移前的原始备份。
  const existing = isPlainObject(state.backup) ? state.backup : null;
  if (existing?.dir && existsSync(existing.dir)) {
    const recorded = [existing.gateway_yaml, existing.secrets_yaml].filter(
      (file) => typeof file === "string" && file,
    );
    const allPresent = recorded.every((file) => existsSync(file));
    if (allPresent) {
      out.log(`复用已有配置备份：${existing.dir}（不重新创建）`);
      if (!Array.isArray(state.installed_before) || state.installed_before.length === 0) {
        state.installed_before = ctx.installed.map((item) => ({
          id: item.id,
          version: item.version,
          api_version: item.api_version,
          backends: item.backends,
        }));
      }
      state.checklist = {
        path: ctx.checklistPath,
        schema: ctx.checklist.schema,
        count: ctx.checklist.plugins.length,
      };
      return existing;
    }
    out.log(`已有备份不完整（目录 ${existing.dir}），重新创建配置备份`, "warn");
  }

  const backupDir = path.join(root, "data", "migrations", MIGRATION, `backup-${timestamp()}`);
  await fsp.mkdir(backupDir, { recursive: true });

  const result = {
    dir: backupDir,
    created_at: nowIso(),
    gateway_yaml: null,
    secrets_yaml: null,
    gateway_existed: false,
    secrets_existed: false,
  };

  for (const name of ["gateway.yaml", "secrets.yaml"]) {
    const source = path.join(root, name);
    const key = name === "gateway.yaml" ? "gateway_yaml" : "secrets_yaml";
    const existedKey = name === "gateway.yaml" ? "gateway_existed" : "secrets_existed";
    if (!existsSync(source)) {
      out.log(`未找到 ${name}，跳过备份`, "warn");
      continue;
    }
    const dest = path.join(backupDir, name);
    const stat = await fsp.stat(source);
    await fsp.copyFile(source, dest);
    await fsp.chmod(dest, stat.mode).catch(() => {});
    result[key] = dest;
    result[existedKey] = true;
    out.log(`已备份 ${name} -> ${dest}`);
  }

  state.backup = result;
  state.installed_before = ctx.installed.map((item) => ({
    id: item.id,
    version: item.version,
    api_version: item.api_version,
    backends: item.backends,
  }));
  state.checklist = {
    path: ctx.checklistPath,
    schema: ctx.checklist.schema,
    count: ctx.checklist.plugins.length,
  };
  return result;
}

async function runPreflight(ctx, { dryRun = false } = {}) {
  logPlan(ctx, { dryRun });
  if (dryRun) {
    if (ctx.state) ctx.state.phases.preflight = { status: "planned" };
    return { status: "planned" };
  }

  const cli = path.join(ctx.root, "bin", "asg.mjs");
  if (!existsSync(cli)) {
    throw new MigrationError(`未找到 CLI 入口：${cli}（请先安装或执行 npm run build）`, 1);
  }
  if (!existsSync(path.join(ctx.root, "gateway.yaml"))) {
    ctx.out.log("未找到 gateway.yaml；config 阶段会跳过配置迁移", "warn");
  }

  await backupConfigs(ctx);
  ctx.out.log(`preflight 完成，备份目录：${ctx.state.backup.dir}`);
  return { status: "done", note: `备份 ${ctx.state.backup.dir}` };
}

async function installAndVerify(ctx, target) {
  await runAsg(ctx, [
    "extensions",
    "install",
    `${target.repo}@${target.version}`,
    "--no-setup",
  ]);

  const installed = await scanInstalledExtensions(ctx.root);
  const item = findInstalled(installed, target.id);
  if (!item) {
    throw new MigrationError(
      `安装命令成功，但未在 data/extensions 中找到插件 ${target.id}`,
      1,
    );
  }
  if (item.version !== target.version) {
    throw new MigrationError(
      `插件 ${target.id} 版本校验失败：期望 ${target.version}，manifest 为 ${item.version ?? "未知"}`,
      1,
    );
  }
  return item;
}

async function runPluginsPhase(ctx) {
  const { state, out } = ctx;
  const installed = await scanInstalledExtensions(ctx.root);
  const failures = [];
  let changed = 0;

  for (const target of ctx.targets) {
    const item = findInstalled(installed, target.id);
    const record = (state.plugins[target.id] ??= {
      id: target.id,
      repo: target.repo,
      from: null,
      to: target.version,
      status: "pending",
    });
    record.repo = target.repo;
    record.to = target.version;

    if (!item) {
      record.status = "skipped";
      record.reason = "未安装";
      record.finished_at = nowIso();
      await saveState(ctx);
      continue;
    }
    if (record.from === null || record.from === undefined) record.from = item.version;

    if (item.version === target.version) {
      if (record.status !== "installed") {
        record.status = "skipped";
        record.reason = record.from === target.version ? "版本未变化" : "版本已一致";
      }
      record.finished_at = nowIso();
      out.log(
        `插件 ${target.id} 已是 ${target.version}，跳过` +
          (record.from && record.from !== target.version ? `（记录 from=${record.from}）` : ""),
      );
      await saveState(ctx);
      continue;
    }

    try {
      out.log(`升级插件 ${target.id}: ${item.version ?? "未知"} -> ${target.version}`);
      const after = await installAndVerify(ctx, target);
      record.status = "installed";
      record.from ??= item.version;
      record.version = after.version;
      record.finished_at = nowIso();
      record.error = undefined;
      changed += 1;
      out.log(`插件 ${target.id} 已升级到 ${after.version}`);
    } catch (error) {
      const message = messageOf(error);
      record.status = "failed";
      record.error = message;
      record.finished_at = nowIso();
      state.errors.push({ phase: "plugins", plugin: target.id, message, time: nowIso() });
      failures.push(target.id);
      out.log(`插件 ${target.id} 升级失败：${message}`, "error", { plugin: target.id });
      if (!ctx.opts.continueOnError) {
        await saveState(ctx);
        throw error;
      }
    }
    await saveState(ctx);
  }

  if (failures.length > 0) {
    throw new MigrationError(
      `${failures.length} 个插件升级失败：${failures.join(", ")}（已按 --continue-on-error 继续其余插件）`,
      1,
    );
  }
  return {
    status: "done",
    note: changed > 0 ? `${changed} 个插件已升级` : "没有需要升级的插件",
  };
}

async function runBackendsPhase(ctx) {
  const { state, out } = ctx;
  const installed = await scanInstalledExtensions(ctx.root);
  const failures = [];
  let setupCount = 0;

  for (const target of ctx.targets) {
    const item = findInstalled(installed, target.id);
    const record = (state.backends[target.id] ??= {
      id: target.id,
      status: "pending",
    });

    if (record.status === "done") {
      record.reason = "已安装，跳过";
      record.skipped = true;
      out.log(`插件 ${target.id} 的后端已安装（state 记录 done），跳过 setup`);
      await saveState(ctx);
      continue;
    }

    if (!item) {
      record.status = "skipped";
      record.reason = "未安装";
      await saveState(ctx);
      continue;
    }
    if (item.backends.length === 0) {
      record.status = "skipped";
      record.reason = "未声明 backends";
      await saveState(ctx);
      continue;
    }

    try {
      const names = backendNames(item.backends);
      out.log(`安装插件后端 ${target.id}: ${names.join(", ")}`);
      await runAsg(ctx, ["extensions", "setup", target.id]);
      record.status = "done";
      record.backends = names;
      record.finished_at = nowIso();
      record.error = undefined;
      setupCount += 1;
      out.log(`插件 ${target.id} 的后端安装完成`);
    } catch (error) {
      const message = messageOf(error);
      record.status = "failed";
      record.error = message;
      record.finished_at = nowIso();
      state.errors.push({ phase: "backends", plugin: target.id, message, time: nowIso() });
      failures.push(target.id);
      out.log(`插件后端安装失败 ${target.id}：${message}`, "error", { plugin: target.id });
      if (!ctx.opts.continueOnError) {
        await saveState(ctx);
        throw error;
      }
    }
    await saveState(ctx);
  }

  if (failures.length > 0) {
    throw new MigrationError(
      `${failures.length} 个插件后端安装失败：${failures.join(", ")}（已按 --continue-on-error 继续）`,
      1,
    );
  }
  return {
    status: "done",
    note: setupCount > 0 ? `${setupCount} 个插件执行了 setup` : "没有需要安装的后端",
  };
}

/** 平台配置从顶层段迁移到 extensions.<plugin-id>.config。 */
const PLATFORM_CONFIG_MOVES = [
  { pluginId: "bilibili", configKey: "bilibili", searchKey: null },
  { pluginId: "weibo", configKey: "weibo", searchKey: "weibo" },
];

function nodeToJs(value, doc) {
  if (value && typeof value.toJS === "function") return value.toJS(doc);
  return value;
}

async function loadYaml() {
  try {
    return await import("yaml");
  } catch (error) {
    throw new MigrationError(
      `config 阶段需要 yaml 依赖（${messageOf(error)}）；请在安装根执行 npm install 后重试`,
      1,
    );
  }
}

function yamlDocument(parseDocument, text, file) {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    throw new MigrationError(`${file} 不是合法 YAML：${doc.errors[0].message}`, 1);
  }
  const extensions = doc.get("extensions");
  if (extensions !== undefined && !isPlainObject(nodeToJs(extensions, doc))) {
    throw new MigrationError(`${file} 的 extensions 必须是对象`, 1);
  }
  return doc;
}

/** 返回是否改动；迁移顶层平台配置与 search.<platform>。 */
function migrateGatewayDocument(doc, { out }) {
  let changed = false;
  for (const move of PLATFORM_CONFIG_MOVES) {
    const configNode = doc.get(move.configKey);
    const searchNode = move.searchKey ? doc.getIn(["search", move.searchKey]) : undefined;
    if (configNode === undefined && searchNode === undefined) continue;

    const targetPath = ["extensions", move.pluginId, "config"];
    if (configNode !== undefined) {
      const current = doc.getIn(targetPath);
      if (current === undefined) {
        doc.setIn(targetPath, nodeToJs(configNode, doc));
      } else {
        doc.setIn(targetPath, {
          ...nodeToJs(current, doc),
          ...nodeToJs(configNode, doc),
        });
        out.log(`extensions.${move.pluginId}.config 已存在，按旧值覆盖同名键`, "warn");
      }
      doc.deleteIn([move.configKey]);
      out.log(`迁移 ${move.configKey} -> extensions.${move.pluginId}.config`);
      changed = true;
    }

    if (searchNode !== undefined) {
      const current = doc.getIn(targetPath);
      const base = current === undefined ? {} : nodeToJs(current, doc);
      const existingSearch = isPlainObject(base.search) ? base.search : {};
      doc.setIn(targetPath, {
        ...base,
        search: { ...existingSearch, ...nodeToJs(searchNode, doc) },
      });
      doc.deleteIn(["search", move.searchKey]);
      out.log(`迁移 search.${move.searchKey} -> extensions.${move.pluginId}.config.search`);
      changed = true;
    }
  }
  return changed;
}

/** 返回是否改动；bilibili.http.token -> extensions.bilibili.token。 */
function migrateSecretsDocument(doc, { out }) {
  const old = doc.get("bilibili");
  if (old === undefined) return false;

  const token = doc.getIn(["bilibili", "http", "token"]);
  if (token !== undefined && doc.getIn(["extensions", "bilibili", "token"]) === undefined) {
    doc.setIn(["extensions", "bilibili", "token"], nodeToJs(token, doc));
    out.log("迁移 secrets.bilibili.http.token -> extensions.bilibili.token");
  } else if (token !== undefined) {
    out.log("extensions.bilibili.token 已存在，保留现有值", "warn");
  }
  doc.deleteIn(["bilibili"]);
  return true;
}

async function runConfigPhase(ctx) {
  const { root, out, state } = ctx;
  if (!state.backup?.dir) {
    out.log("config 阶段没有前置备份，先创建配置备份", "warn");
    await backupConfigs(ctx);
  }

  const yaml = await loadYaml();
  const changed = [];
  for (const name of ["gateway.yaml", "secrets.yaml"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) {
      out.log(`未找到 ${name}，跳过`, "warn");
      continue;
    }
    const text = await fsp.readFile(file, "utf8");
    const doc = yamlDocument(yaml.parseDocument, text, name);
    const dirty =
      name === "gateway.yaml"
        ? migrateGatewayDocument(doc, { out })
        : migrateSecretsDocument(doc, { out });
    if (!dirty) {
      out.log(`${name} 无需迁移`);
      continue;
    }
    // secrets.yaml 无论原权限如何都收紧到 0600；gateway.yaml 保留原有模式。
    await writeTextAtomic(
      file,
      doc.toString({ lineWidth: 0 }),
      name === "secrets.yaml" ? { mode: SECRETS_FILE_MODE } : {},
    );
    changed.push(name);
  }

  if (changed.length === 0) {
    return { status: "done", note: "没有需要迁移的平台配置" };
  }
  return { status: "done", note: `已迁移 ${changed.join(" / ")}` };
}

/** 从 gateway.yaml 读 gateway.host / gateway.port（无 YAML 依赖）。 */
export function readGatewayAddress(root) {
  let host = "127.0.0.1";
  let port = 3000;
  const file = path.join(root, "gateway.yaml");
  if (!existsSync(file)) return { host, port };

  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { host, port };
  }

  let inGateway = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!inGateway) {
      if (/^gateway:\s*(?:#.*)?$/.test(line)) inGateway = true;
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = (line.match(/^\s*/) ?? [""])[0].length;
    if (indent === 0) break;
    const match = /^([A-Za-z0-9_]+):\s*(.*?)\s*(?:#.*)?$/.exec(trimmed);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (match[1] === "host" && value) host = value;
    if (match[1] === "port" && /^\d+$/.test(value)) port = Number(value);
  }
  return { host, port };
}

function gatewayIsUp(status) {
  if (!isPlainObject(status)) return false;
  if (status.services?.gateway?.up === true) return true;
  if (status.gateway?.up === true) return true;
  return false;
}

async function probeStatus(ctx) {
  const cli = path.join(ctx.root, "bin", "asg.mjs");
  try {
    const result = await ctx.runner({
      command: ctx.execPath,
      args: [cli, "status", "--json"],
      cwd: ctx.root,
      env: ctx.env,
      timeoutMs: Math.min(ctx.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 10_000),
    });
    const code = result?.status ?? result?.exitCode ?? 1;
    if (code !== 0) return false;
    return gatewayIsUp(parseLastJson(result?.stdout));
  } catch {
    return false;
  }
}

async function probeHttp(ctx) {
  const { host, port } = readGatewayAddress(ctx.root);
  const connectHost = ["0.0.0.0", "::", "[::]"].includes(host) ? "127.0.0.1" : host;
  const formatted = connectHost.includes(":") ? `[${connectHost}]` : connectHost;
  try {
    const response = await fetch(`http://${formatted}:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    // 仅 2xx 不足以说明服务已就绪：必须能解析出 gateway.version（字符串）。
    return (
      isPlainObject(data) &&
      typeof data.gateway?.version === "string" &&
      data.gateway.version.length > 0
    );
  } catch {
    return false;
  }
}

async function waitForGateway(ctx) {
  const timeoutMs = ctx.healthTimeoutMs;
  const intervalMs = ctx.healthIntervalMs;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() <= deadline) {
    attempts += 1;
    if (ctx.healthCheck) {
      let healthy = false;
      try {
        healthy = await ctx.healthCheck(ctx);
      } catch {
        healthy = false;
      }
      if (healthy) {
        ctx.out.log(`网关健康检查通过（自定义检查，第 ${attempts} 次）`);
        return;
      }
      await sleep(intervalMs);
      continue;
    }

    if (await probeStatus(ctx)) {
      ctx.out.log(`网关健康检查通过（status，第 ${attempts} 次）`);
      return;
    }
    if (await probeHttp(ctx)) {
      ctx.out.log(`网关健康检查通过（/health，第 ${attempts} 次）`);
      return;
    }
    await sleep(intervalMs);
  }

  throw new MigrationError(
    `等待网关健康检查超时（${timeoutMs}ms，轮询 ${attempts} 次）。` +
      `\n处理：检查 gateway.yaml 的 host/port、logs 与 asg status；修复后可用 --resume 从 restart 继续。`,
    1,
  );
}

async function runRestartPhase(ctx) {
  if (ctx.opts.noRestart) {
    ctx.out.log("restart 阶段已按 --no-restart 跳过");
    return { status: "skipped", note: "--no-restart" };
  }
  if (!hasActionableTargets(ctx)) {
    ctx.out.log("没有可处理的迁移目标，跳过 restart（不重启网关）", "warn");
    return { status: "skipped", note: "没有可处理目标" };
  }
  await runAsg(ctx, ["restart"]);
  await waitForGateway(ctx);
  return { status: "done" };
}

async function executePhase(ctx, phase) {
  const record = (ctx.state.phases[phase] ??= { status: "pending" });
  ctx.currentPhase = phase;
  record.status = "running";
  record.started_at = nowIso();
  record.error = undefined;
  await saveState(ctx);

  try {
    let result;
    if (phase === "preflight") result = await runPreflight(ctx);
    else if (phase === "plugins") result = await runPluginsPhase(ctx);
    else if (phase === "backends") result = await runBackendsPhase(ctx);
    else if (phase === "config") result = await runConfigPhase(ctx);
    else if (phase === "restart") result = await runRestartPhase(ctx);
    else throw new MigrationError(`未知阶段：${phase}`, 2);

    record.status = result?.status ?? "done";
    if (result?.note) record.note = result.note;
    record.finished_at = nowIso();
    await saveState(ctx);
  } catch (error) {
    const message = messageOf(error);
    record.status = "failed";
    record.error = message;
    record.finished_at = nowIso();
    ctx.state.errors.push({ phase, message, time: nowIso() });
    await saveState(ctx);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 回滚
// ---------------------------------------------------------------------------

async function restoreBackup(ctx, key, name) {
  const { state, root, out } = ctx;
  const backupFile = state.backup?.[key];
  if (!backupFile) {
    return { status: "skipped", reason: "无备份记录" };
  }
  if (!existsSync(backupFile)) {
    const message = `备份文件缺失：${backupFile}`;
    out.log(message, "error");
    return { status: "failed", error: message };
  }
  try {
    await fsp.copyFile(backupFile, path.join(root, name));
    out.log(`已恢复 ${name} <- ${backupFile}`);
    return { status: "restored", from: backupFile };
  } catch (error) {
    const message = `恢复 ${name} 失败：${messageOf(error)}`;
    out.log(message, "error");
    return { status: "failed", error: message };
  }
}

async function performRollback(ctx) {
  const { state, out } = ctx;
  const rollback = {
    started_at: nowIso(),
    finished_at: null,
    status: "running",
    config: {},
    plugins: {},
    errors: [],
  };

  out.log("开始回滚：恢复配置备份，并按记录重装旧插件版本");
  rollback.config.gateway_yaml = await restoreBackup(ctx, "gateway_yaml", "gateway.yaml");
  rollback.config.secrets_yaml = await restoreBackup(ctx, "secrets_yaml", "secrets.yaml");
  for (const [name, item] of Object.entries(rollback.config)) {
    if (item.status === "failed") {
      rollback.errors.push({ target: "config", name, message: item.error });
    }
  }

  const installed = await scanInstalledExtensions(ctx.root);
  for (const record of Object.values(state.plugins)) {
    if (!record?.repo || !record?.from) {
      rollback.plugins[record?.id ?? "unknown"] = {
        status: "skipped",
        reason: "没有旧版本记录",
      };
      continue;
    }
    if (record.from === record.to) {
      rollback.plugins[record.id] = { status: "skipped", reason: "版本未变化" };
      continue;
    }

    const current = findInstalled(installed, record.id);
    if (current?.version === record.from) {
      rollback.plugins[record.id] = {
        status: "skipped",
        reason: `已是 ${record.from}`,
      };
      continue;
    }

    const target = { id: record.id, repo: record.repo, version: record.from };
    try {
      out.log(`回滚插件 ${record.id}: ${current?.version ?? "未知"} -> ${record.from}`);
      await installAndVerify(ctx, target);
      rollback.plugins[record.id] = {
        status: "restored",
        from: current?.version ?? null,
        to: record.from,
      };
    } catch (error) {
      const message = messageOf(error);
      rollback.plugins[record.id] = { status: "failed", error: message };
      rollback.errors.push({ target: "plugins", plugin: record.id, message });
      out.log(`回滚插件 ${record.id} 失败：${message}`, "error", { plugin: record.id });
    }
  }

  rollback.finished_at = nowIso();
  const hasConfigBackup = Boolean(state.backup?.gateway_yaml || state.backup?.secrets_yaml);
  if (!hasConfigBackup) {
    rollback.warning = "没有配置备份，仅回滚了插件版本（如有）";
  }
  rollback.status =
    rollback.errors.length > 0 ? "failed" : hasConfigBackup ? "done" : "done-with-warning";
  state.rollback = rollback;
  ctx.currentPhase = "rollback";
  await saveState(ctx);

  const summary =
    rollback.status === "done"
      ? "回滚完成"
      : rollback.status === "done-with-warning"
        ? "回滚结束（有警告）"
        : "回滚存在失败";
  out.log(
    `${summary}${rollback.warning ? `：${rollback.warning}` : ""}；` +
      "data/extension-data 与 data/backends 按约定保留，核心版本不在此脚本回滚范围内",
    rollback.status === "failed" ? "error" : "info",
  );
  return rollback;
}

function rollbackPlan(ctx) {
  const { state, out } = ctx;
  out.log("回滚计划（dry-run 不执行）:");
  const gateway = state.backup?.gateway_yaml;
  const secrets = state.backup?.secrets_yaml;
  out.log(`  恢复 gateway.yaml: ${gateway ?? "无备份"}`);
  out.log(`  恢复 secrets.yaml: ${secrets ?? "无备份"}`);
  if (!gateway && !secrets) {
    out.log("  没有配置备份，回滚将只能重装旧插件版本（如有）", "warn");
  }
  const plugins = Object.values(state.plugins).filter(
    (record) => record?.repo && record?.from,
  );
  if (plugins.length === 0) {
    out.log("  插件回滚: 无记录");
  } else {
    for (const record of plugins) {
      out.log(
        `  - ${record.id}: ${record.to ?? "?"} -> ${record.from}` +
          (record.from === record.to ? "（版本未变化，跳过）" : ""),
      );
    }
  }
  out.log("不删除 data/extension-data 与 data/backends；核心版本不在此脚本回滚范围内");
}

async function runRollback(opts, overrides, out) {
  const root = resolveRoot(opts.root);
  const stateFile = path.join(root, "data", "migrations", MIGRATION, "state.json");

  let state;
  try {
    state = await loadState(stateFile, root);
  } catch (error) {
    return {
      exitCode: error?.exitCode ?? 1,
      result: {
        schema: STATE_SCHEMA,
        migration: MIGRATION,
        ok: false,
        phase: "rollback",
        dry_run: opts.dryRun,
        root,
        state_file: stateFile,
        error: messageOf(error),
      },
    };
  }
  if (!state) {
    const message = `未找到迁移状态：${stateFile}（无法回滚）`;
    out.log(message, "error");
    return {
      exitCode: 1,
      result: {
        schema: STATE_SCHEMA,
        migration: MIGRATION,
        ok: false,
        phase: "rollback",
        dry_run: opts.dryRun,
        root,
        state_file: stateFile,
        error: message,
      },
    };
  }

  const ctx = {
    root,
    opts,
    out,
    state,
    stateFile,
    execPath: overrides.execPath ?? process.execPath,
    runner: overrides.runner ?? createCommandRunner(),
    env: overrides.env ?? process.env,
    healthTimeoutMs: overrides.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    healthIntervalMs: overrides.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
    commandTimeoutMs: commandTimeoutFrom(overrides),
    currentPhase: "rollback",
  };

  checkNodeVersion();
  if (opts.dryRun) {
    rollbackPlan(ctx);
    return {
      exitCode: 0,
      result: {
        schema: STATE_SCHEMA,
        migration: MIGRATION,
        ok: true,
        phase: "rollback",
        dry_run: true,
        root,
        state_file: stateFile,
        backup_dir: state.backup?.dir ?? null,
        phases: Object.fromEntries(
          PHASES.map((phase) => [phase, state.phases?.[phase]?.status ?? "pending"]),
        ),
        rollback: { status: "planned" },
      },
    };
  }

  const rollback = await performRollback(ctx);
  const rollbackOk = rollback.status !== "failed";
  return {
    exitCode: rollbackOk ? 0 : 1,
    result: {
      schema: STATE_SCHEMA,
      migration: MIGRATION,
      ok: rollbackOk,
      phase: "rollback",
      dry_run: false,
      root,
      state_file: stateFile,
      backup_dir: state.backup?.dir ?? null,
      phases: Object.fromEntries(
        PHASES.map((phase) => [phase, state.phases?.[phase]?.status ?? "pending"]),
      ),
      plugins: Object.values(state.plugins),
      backends: state.backends,
      rollback,
      errors: state.errors,
      error:
        rollback.status === "failed"
          ? "部分回滚步骤失败，详见 rollback.errors"
          : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function buildResult(ctx, { ok, extra = {} }) {
  const state = ctx.state;
  return {
    schema: STATE_SCHEMA,
    migration: MIGRATION,
    ok,
    phase: ctx.opts.phase,
    dry_run: Boolean(ctx.opts.dryRun),
    root: ctx.root,
    state_file: ctx.state ? ctx.stateFile : null,
    backup_dir: state?.backup?.dir ?? null,
    checklist: state?.checklist ?? null,
    phases: state
      ? Object.fromEntries(
          PHASES.map((phase) => [phase, state.phases?.[phase]?.status ?? "pending"]),
        )
      : Object.fromEntries(PHASES.map((phase) => [phase, "pending"])),
    plugins: state ? Object.values(state.plugins) : [],
    backends: state?.backends ?? {},
    errors: state?.errors ?? [],
    ...extra,
  };
}

/** 执行迁移（不含参数解析）；返回 { exitCode, result }。 */
export async function runMigration(opts, overrides = {}, out = createReporter(opts.jsonl)) {
  const root = resolveRoot(opts.root);
  const stateFile = path.join(root, "data", "migrations", MIGRATION, "state.json");
  const checklistPath =
    overrides.checklistPath ??
    process.env.ASG_MIGRATION_MANIFEST ??
    DEFAULT_CHECKLIST;

  if (opts.rollback) return await runRollback(opts, overrides, out);

  if (opts.dryRun) {
    const ctx = {
      root,
      opts,
      out,
      stateFile,
      checklistPath,
      execPath: overrides.execPath ?? process.execPath,
      runner: overrides.runner ?? createCommandRunner(),
      env: overrides.env ?? process.env,
      healthTimeoutMs: overrides.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      healthIntervalMs: overrides.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
      commandTimeoutMs: commandTimeoutFrom(overrides),
      currentPhase: "preflight",
    };
    ctx.state = initialState(root, checklistPath);

    try {
      await prepareContext(ctx);
      await runPreflight(ctx, { dryRun: true });
      return {
        exitCode: 0,
        result: buildResult(ctx, {
          ok: true,
          extra: { dry_run: true, state_file: null, planned_state_file: stateFile },
        }),
      };
    } catch (error) {
      const message = messageOf(error);
      out.log(message, "error");
      return {
        exitCode: error?.exitCode ?? 1,
        result: {
          schema: STATE_SCHEMA,
          migration: MIGRATION,
          ok: false,
          phase: "preflight",
          dry_run: true,
          root,
          error: message,
        },
      };
    }
  }

  let state;
  try {
    state = (await loadState(stateFile, root)) ?? initialState(root, checklistPath);
  } catch (error) {
    const message = messageOf(error);
    out.log(message, "error");
    return {
      exitCode: error?.exitCode ?? 1,
      result: {
        schema: STATE_SCHEMA,
        migration: MIGRATION,
        ok: false,
        phase: opts.phase,
        dry_run: false,
        root,
        state_file: stateFile,
        error: message,
      },
    };
  }

  state.root = root;
  const ctx = {
    root,
    opts,
    out,
    state,
    stateFile,
    checklistPath,
    execPath: overrides.execPath ?? process.execPath,
    runner: overrides.runner ?? createCommandRunner(),
    env: overrides.env ?? process.env,
    healthTimeoutMs: overrides.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    healthIntervalMs: overrides.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
    commandTimeoutMs: commandTimeoutFrom(overrides),
    healthCheck: overrides.healthCheck,
    currentPhase: opts.phase === "all" ? "preflight" : opts.phase,
  };

  try {
    await prepareContext(ctx);
  } catch (error) {
    const message = messageOf(error);
    const phase = opts.phase === "all" ? "preflight" : opts.phase;
    state.phases[phase] = {
      ...(state.phases[phase] ?? {}),
      status: "failed",
      error: message,
      finished_at: nowIso(),
    };
    state.errors.push({ phase, message, time: nowIso() });
    await saveState(ctx).catch(() => {});
    out.log(message, "error");
    return {
      exitCode: error?.exitCode ?? 1,
      result: buildResult(ctx, { ok: false, extra: { error: message } }),
    };
  }

  let phases;
  if (opts.phase === "all") {
    const start = opts.resume ? firstIncompletePhase(state) : "preflight";
    if (start === null) {
      out.log("所有阶段均已完成，无需续跑");
      return { exitCode: 0, result: buildResult(ctx, { ok: true }) };
    }
    phases = PHASES.slice(PHASES.indexOf(start));
  } else {
    phases = [opts.phase];
  }

  if (phases[0] !== "preflight" && !state.backup?.dir) {
    out.log(
      "未执行 preflight（没有配置备份）；后续 --rollback 只能回滚插件版本，无法恢复配置",
      "warn",
    );
  }

  for (const phase of phases) {
    try {
      await executePhase(ctx, phase);
    } catch (error) {
      const message = messageOf(error);
      const extra = { error: message };
      if (opts.rollbackOnFailure) {
        out.log("阶段失败，按 --rollback-on-failure 执行回滚", "warn");
        try {
          extra.rollback = await performRollback(ctx);
        } catch (rollbackError) {
          extra.rollback = {
            status: "failed",
            error: messageOf(rollbackError),
          };
          out.log(`自动回滚失败：${messageOf(rollbackError)}`, "error");
        }
      }
      return { exitCode: 1, result: buildResult(ctx, { ok: false, extra }) };
    }
  }

  return { exitCode: 0, result: buildResult(ctx, { ok: true }) };
}

/** CLI 入口；返回进程退出码。 */
export async function main(argv = process.argv.slice(2), overrides = {}) {
  const wantsJsonl = argv.includes("--jsonl");
  let opts = null;
  let out = createReporter(wantsJsonl);

  const emitFailure = (error, phase) => {
    const message = messageOf(error);
    const payload = {
      schema: STATE_SCHEMA,
      migration: MIGRATION,
      ok: false,
      phase,
      dry_run: opts?.dryRun ?? argv.includes("--dry-run"),
      error: message,
    };
    try {
      out.log(message, "error");
    } catch {
      // 输出通道异常时至少保证 result 行。
    }
    try {
      out.result(payload);
    } catch {
      try {
        process.stdout.write(`${JSON.stringify({ type: "result", ...payload })}\n`);
      } catch {
        // 无法输出时只能依赖退出码。
      }
    }
    return error?.exitCode ?? (opts ? 1 : 2);
  };

  try {
    opts = parseArgs(argv);
    out = createReporter(opts.jsonl);
    if (opts.help) {
      if (opts.jsonl) out.log(USAGE);
      else process.stdout.write(USAGE);
      return 0;
    }

    const { exitCode, result } = await runMigration(opts, overrides, out);
    out.result(result);
    return exitCode;
  } catch (error) {
    return emitFailure(error, opts?.phase ?? null);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      // main 理论上不会 reject；兜底时也必须让 --jsonl 的最后一行是 result。
      const message = messageOf(error);
      process.stderr.write(`[migrate ${MIGRATION}] ${message}\n`);
      if (process.argv.includes("--jsonl")) {
        try {
          process.stdout.write(
            `${JSON.stringify({
              type: "result",
              schema: STATE_SCHEMA,
              migration: MIGRATION,
              ok: false,
              phase: null,
              dry_run: process.argv.includes("--dry-run"),
              error: message,
            })}\n`,
          );
        } catch {
          // 无法输出时只能依赖退出码。
        }
      }
      process.exitCode = 1;
    },
  );
}
