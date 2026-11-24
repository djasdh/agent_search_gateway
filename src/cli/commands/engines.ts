/**
 * `asg engines list|enable|disable|route|secret`。
 *
 * 统一目录见 `src/cli/engines/`；本命令只负责参数解析、人类输出与一次整栈重启。
 */

import process from "node:process";
import type { CommandFn, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { takeFlag, takeValue } from "../args.js";
import { restartForConfig } from "../runtime/stack.js";
import { loadExtensions } from "../../extensions/loader.js";
import { setExternalEngineProviders } from "../../engines/registry.js";
import type { EngineRecord } from "../../engines/types.js";
import type { Logger } from "../../logger.js";
import {
  listEngines,
  parseEngineRef,
  readLocalEngines,
  resolveEngineRecord,
  setEngines,
  type EngineInfo,
} from "../config/engines.js";
import { loadEngineContext } from "../engines/context.js";
import { parseSearxngSecretRequirement } from "../engines/requirements.js";
import { asObject, stringArray } from "../engines/shared.js";
import type { EngineContext } from "../engines/types.js";
import {
  deleteYamlPath,
  documentToText,
  getYamlPath,
  readTextIfExists,
  readYamlDocument,
  setYamlPath,
  writeConfigFile,
  writeFileAtomic,
} from "../config/gateway.js";
import { renderSearxngEngineApiKey } from "../config/searxng.js";
import { validateConfigTexts } from "../config/validate.js";

const RESTART_NOTICE = "整栈重启会断开所有 MCP 连接。";

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

function usage(message: string): never {
  throw new CliError("UNEXPECTED", EXIT.USAGE, message);
}

/** 轻量 logger：扩展告警走 Reporter 事件，不污染 list 的 stdout。 */
function extensionLogger(reporter: Reporter): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string) =>
      reporter.event({ event: "log", service: "extensions", level: "warn", message }),
    error: () => {},
    close: () => {},
  } as unknown as Logger;
}

/** 加载已安装扩展的 search 插件；单个坏包只告警，不让 `asg engines` 整体失败。 */
async function applyExtensions(root: string, reporter: Reporter): Promise<void> {
  // 引擎策略/密钥存在 gateway.yaml / secrets.yaml，CLI 也要按用户配置包装插件。
  // 配置可能尚未经过 schema 校验（例如非法 YAML 字段），loader 内部会做防御性读取。
  const ctx = loadEngineContext(root);
  try {
    const loaded = await loadExtensions(root, {
      logger: extensionLogger(reporter),
      extensionConfig: asObject(ctx.configPlain.extensions),
      extensionSecrets: asObject(ctx.secrets.extensions),
    });
    setExternalEngineProviders(loaded.engines);
  } catch (error) {
    reporter.event({
      event: "log",
      service: "extensions",
      level: "warn",
      message: `扩展加载失败，继续使用内置引擎：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function renderTable(engines: EngineInfo[], withSource: boolean): string {
  const header = withSource
    ? ["ID", "KIND", "ENABLED", "AVAILABLE", "ROUTING", "SOURCE", "REQUIRES"]
    : ["ID", "KIND", "ENABLED", "AVAILABLE", "ROUTING", "REQUIRES"];

  const rows = engines.map((engine) => {
    const base = [
      engine.id,
      engine.kind,
      engine.enabled ? "yes" : "no",
      engine.available ? "yes" : "no",
      engine.routing.length > 0 ? engine.routing.join(",") : "-",
    ];
    if (withSource) base.push(engine.source ?? "-");
    base.push(engine.requires && engine.requires.length > 0 ? engine.requires.join(",") : "-");
    return base;
  });

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]!.length)),
  );
  const format = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();

  return [format(header), ...rows.map((row) => format(row))].join("\n");
}

async function runList(root: string, reporter: Reporter, args: string[]): Promise<CommandResult> {
  const all = takeFlag(args, "--all");
  if (args.length > 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "用法: asg engines list [--all]");
  }

  await applyExtensions(root, reporter);
  const engines = await listEngines(root, { all });
  return {
    data: { scope: all ? "all" : "local", engines },
    human: renderTable(engines, all),
  };
}

async function runToggle(
  root: string,
  reporter: Reporter,
  action: "enable" | "disable",
  args: string[],
): Promise<CommandResult> {
  const usage = `用法: asg engines ${action} <name|group:name...>`;
  if (args.some((arg) => arg.startsWith("-"))) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `${usage}（不接受选项）`);
  }
  if (args.length === 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, usage);
  }

  await applyExtensions(root, reporter);
  const local = readLocalEngines(root);
  const localIds = new Set(local.map((engine) => engine.id));
  const localNames = new Set(local.map((engine) => engine.name));

  // 只有 searxng 组（含裸名）可能落在远端默认列表；gateway 组不做远端兜底。
  const needsRemote: Array<{ raw: string; name: string }> = [];
  for (const raw of args) {
    const ref = parseEngineRef(raw);
    if (!ref.name) continue;
    if (ref.group && ref.group !== "searxng") continue;
    const localHit = ref.group ? localIds.has(`${ref.group}:${ref.name}`) : localNames.has(ref.name);
    if (!localHit) needsRemote.push({ raw, name: ref.name });
  }

  let knownSearxng: string[] = [];
  if (needsRemote.length > 0) {
    // 本地没有的名字可能是 searxng 默认引擎：在线时用 /config 全量列表校验。
    let all: EngineInfo[];
    try {
      all = await listEngines(root, { all: true });
    } catch (error) {
      if (error instanceof CliError && error.code === "BACKEND_DOWN") {
        const names = needsRemote.map((item) => item.raw);
        throw new CliError(
          "ENGINE_NOT_FOUND",
          EXIT.INVALID,
          `未知引擎：${names.join(", ")}（searxng 未运行，无法确认默认引擎）`,
          { engines: names },
        );
      }
      throw error;
    }
    const known = new Set(
      all.filter((engine) => engine.kind === "searxng").map((engine) => engine.name),
    );
    const missing = needsRemote.filter((item) => !known.has(item.name));
    if (missing.length > 0) {
      const names = missing.map((item) => item.raw);
      throw new CliError("ENGINE_NOT_FOUND", EXIT.INVALID, `未知引擎：${names.join(", ")}`, {
        engines: names,
      });
    }
    knownSearxng = needsRemote.map((item) => item.name);
  }

  const { changed } = setEngines(root, args, action === "enable", { knownSearxng });
  await restart(root, reporter);

  const verb = action === "enable" ? "启用" : "禁用";
  return {
    data: { changed, restart: "all", restarted: true },
    human: [`已${verb}: ${changed.join(", ")}`, "服务已整栈重启并通过健康检查。", RESTART_NOTICE].join("\n"),
  };
}

// ---- route / secret ----

const SEARXNG_ROUTES = new Set(["resident", "rotating", "none"]);

function requireSingleEngine(raw: string | undefined, usageText: string): string {
  if (!raw) usage(usageText);
  return raw;
}

async function resolveTarget(
  root: string,
  reporter: Reporter,
  raw: string,
): Promise<{ ctx: EngineContext; record: EngineRecord }> {
  await applyExtensions(root, reporter);
  const ctx = loadEngineContext(root);
  return { ctx, record: resolveEngineRecord(raw, ctx) };
}

/**
 * route 的目标解析：与 enable 一致，本地没有的裸名 / searxng 名可能是 searxng
 * 默认引擎；在线时用 `/config` 确认后允许写入 resident / rotating。
 */
async function resolveRouteTarget(
  root: string,
  reporter: Reporter,
  raw: string,
): Promise<{ ctx: EngineContext; record: EngineRecord }> {
  try {
    return await resolveTarget(root, reporter, raw);
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "ENGINE_NOT_FOUND") throw error;
    const ref = parseEngineRef(raw);
    if (ref.group !== undefined && ref.group !== "searxng") throw error;

    const all = await listEngines(root, { all: true });
    const known = new Set(
      all.filter((engine) => engine.kind === "searxng").map((engine) => engine.name),
    );
    if (!known.has(ref.name)) throw error;

    const ctx = loadEngineContext(root);
    return { ctx, record: resolveEngineRecord(raw, ctx, known) };
  }
}

function categoryName(raw: string | undefined, flag: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) usage(`${flag} 需要一个非空类别名`);
  if (value.includes(",")) usage(`${flag} 的类别名不能包含逗号`);
  return value;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function renderRouting(routing: readonly string[]): string {
  return routing.length > 0 ? routing.join(", ") : "-";
}

function routingFrom(value: unknown): string[] {
  const routing = asObject(value);
  const result: string[] = [];
  if (typeof routing.category === "string" && routing.category.trim()) {
    result.push(`category:${routing.category.trim()}`);
  }
  if (typeof routing.hot_category === "string" && routing.hot_category.trim()) {
    result.push(`category:${routing.hot_category.trim()}`);
  }
  return result;
}

function writeConfigText(ctx: EngineContext, reporter: Reporter, text: string): void {
  const { warnings } = validateConfigTexts({
    configText: text,
    secretsText: readTextIfExists(ctx.paths.secrets),
  });
  for (const warning of warnings) reporter.info(`警告: ${warning}`);
  writeConfigFile(ctx.paths.config, text);
}

function planSearxngRoute(
  ctx: EngineContext,
  record: EngineRecord,
  route: string,
): { changed: string[]; routing: string[]; text?: string } {
  const residentPath = ["search", "engines", "resident"];
  const rotatingPath = ["search", "engines", "rotating"];
  const resident = stringArray(getYamlPath(ctx.config.doc, residentPath));
  const rotating = stringArray(getYamlPath(ctx.config.doc, rotatingPath));

  const remove = (list: string[]): string[] => list.filter((name) => name !== record.name);
  let nextResident = [...resident];
  let nextRotating = [...rotating];

  if (route === "none") {
    nextResident = remove(nextResident);
    nextRotating = remove(nextRotating);
  } else if (route === "resident") {
    nextResident = resident.includes(record.name) ? resident : [...resident, record.name];
    nextRotating = remove(rotating);
  } else {
    nextRotating = rotating.includes(record.name) ? rotating : [...rotating, record.name];
    nextResident = remove(resident);
  }

  const changed: string[] = [];
  if (!sameList(resident, nextResident)) {
    setYamlPath(ctx.config.doc, residentPath, nextResident);
    changed.push(residentPath.join("."));
  }
  if (!sameList(rotating, nextRotating)) {
    setYamlPath(ctx.config.doc, rotatingPath, nextRotating);
    changed.push(rotatingPath.join("."));
  }

  return {
    changed,
    routing: route === "none" ? [] : [route],
    text: changed.length > 0 ? documentToText(ctx.config.doc) : undefined,
  };
}

function planGatewaySearchRoute(
  ctx: EngineContext,
  record: EngineRecord,
  category: string | undefined,
  hotCategory: string | undefined,
  clear: boolean,
): { changed: string[]; routing: string[]; text?: string } {
  const base = ["extensions", record.id, "routing"];
  const changed: string[] = [];

  if (clear) {
    if (deleteYamlPath(ctx.config.doc, base)) changed.push(base.join("."));
    return {
      changed,
      routing: [],
      text: changed.length > 0 ? documentToText(ctx.config.doc) : undefined,
    };
  }

  const current = asObject(getYamlPath(ctx.config.doc, base));
  if (category !== undefined && current.category !== category) {
    setYamlPath(ctx.config.doc, [...base, "category"], category);
    changed.push([...base, "category"].join("."));
  }
  if (hotCategory !== undefined && current.hot_category !== hotCategory) {
    setYamlPath(ctx.config.doc, [...base, "hot_category"], hotCategory);
    changed.push([...base, "hot_category"].join("."));
  }

  return {
    changed,
    routing: routingFrom(getYamlPath(ctx.config.doc, base)),
    text: changed.length > 0 ? documentToText(ctx.config.doc) : undefined,
  };
}

async function runRoute(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const usageText =
    "用法: asg engines route <engine> resident|rotating|none | --category <name> [--hot-category <name>] | --clear";
  const [engineRaw, ...rest] = args;
  const engine = requireSingleEngine(engineRaw, usageText);

  const clear = takeFlag(rest, "--clear");
  const category = categoryName(takeValue(rest, "--category"), "--category");
  const hotCategory = categoryName(takeValue(rest, "--hot-category"), "--hot-category");

  const { ctx, record } = await resolveRouteTarget(root, reporter, engine);

  if (record.group === "searxng") {
    if (clear || category !== undefined || hotCategory !== undefined) {
      usage("searxng 路由只接受位置参数 resident|rotating|none");
    }
    if (rest.length !== 1 || !SEARXNG_ROUTES.has(rest[0]!)) {
      usage("用法: asg engines route searxng:<name> resident|rotating|none");
    }
    const route = rest[0]!;
    const planned = planSearxngRoute(ctx, record, route);
    if (planned.text) writeConfigText(ctx, reporter, planned.text);
    await restart(root, reporter);

    return {
      data: {
        engine: record.id,
        routing: planned.routing,
        changed: planned.changed,
        restart: "all",
        restarted: true,
      },
      human: [
        planned.changed.length > 0
          ? `已设置路由: ${record.id} → ${renderRouting(planned.routing)}`
          : `路由未变化: ${record.id} → ${renderRouting(planned.routing)}`,
        "服务已整栈重启并通过健康检查。",
        RESTART_NOTICE,
      ].join("\n"),
    };
  }

  if (record.group === "gateway.upstream") {
    throw new CliError(
      "ENGINE_NO_ROUTING",
      EXIT.INVALID,
      `${record.id} 不支持类别路由；请使用 asg engines enable/disable 控制`,
      { engine: record.id },
    );
  }

  if (record.group === "gateway.search") {
    if (rest.length > 0) usage("gateway.search 路由只接受 --category / --hot-category / --clear");
    if (clear && (category !== undefined || hotCategory !== undefined)) {
      usage("--clear 不能与 --category / --hot-category 同时使用");
    }
    if (!clear && category === undefined && hotCategory === undefined) {
      usage("gateway.search 路由至少需要一个类别或 --clear");
    }

    const planned = planGatewaySearchRoute(ctx, record, category, hotCategory, clear);
    if (planned.text) writeConfigText(ctx, reporter, planned.text);
    await restart(root, reporter);

    const summary =
      planned.changed.length === 0
        ? clear
          ? `路由已是默认值: ${record.id}`
          : `路由未变化: ${record.id} → ${renderRouting(planned.routing)}`
        : clear
          ? `已清除路由: ${record.id}（回退插件默认）`
          : `已设置路由: ${record.id} → ${renderRouting(planned.routing)}`;

    return {
      data: {
        engine: record.id,
        routing: planned.routing,
        changed: planned.changed,
        restart: "all",
        restarted: true,
      },
      human: [summary, "服务已整栈重启并通过健康检查。", RESTART_NOTICE].join("\n"),
    };
  }

  throw new CliError(
    "ENGINE_NO_ROUTING",
    EXIT.INVALID,
    `${record.id} 不支持路由策略；请使用 asg engines enable/disable 控制 search.reverse_image.sources`,
    { engine: record.id },
  );
}

interface SecretDependency {
  /** requires 里的原始写法：`secrets.a.b` / `secret:name` / `searxng.engines.<name>.api_key`。 */
  raw: string;
  kind: "builtin" | "extension" | "searxng";
  path: string[];
  /** 扩展密钥名（仅 extension）或 searxng 引擎名（仅 searxng）。 */
  name?: string;
}

const EXTENSION_SECRET_NAME = /^[a-z][a-z0-9_-]*$/;

function secretDependencies(record: EngineRecord): SecretDependency[] {
  const deps: SecretDependency[] = [];
  const seen = new Set<string>();

  for (const requirement of record.requires ?? []) {
    let dep: SecretDependency | undefined;
    if (requirement.startsWith("secrets.")) {
      const path = requirement.slice("secrets.".length).split(".");
      dep = { raw: requirement, kind: "builtin", path };
    } else if (requirement.startsWith("secret:")) {
      const name = requirement.slice("secret:".length);
      // 0.4.0 起运行期只读 manifest id；engineId 仅用于 routing。
      const owner = record.pluginId ?? record.id;
      dep = {
        raw: requirement,
        kind: "extension",
        path: ["extensions", owner, name],
        name,
      };
    } else {
      const engineName = parseSearxngSecretRequirement(requirement);
      if (engineName !== undefined) {
        dep = { raw: requirement, kind: "searxng", path: [], name: engineName };
      }
    }
    if (!dep || dep.path.some((segment) => segment.length === 0)) continue;
    const key = dep.kind === "searxng" ? dep.raw : dep.path.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    deps.push(dep);
  }

  return deps;
}

function matchesSecretName(dep: SecretDependency, name: string): boolean {
  if (name === dep.raw) return true;
  if (dep.kind === "searxng") return name === "api_key";
  if (dep.kind === "builtin") {
    return name === dep.path.join(".") || name === dep.path[dep.path.length - 1];
  }
  return name === dep.name;
}

function selectSecretDependency(
  record: EngineRecord,
  deps: readonly SecretDependency[],
  name: string | undefined,
): SecretDependency {
  if (name === undefined) {
    if (deps.length === 0) {
      throw new CliError(
        "ENGINE_NO_SECRET",
        EXIT.INVALID,
        `${record.id} 没有可配置的密钥依赖`,
        { engine: record.id },
      );
    }
    if (deps.length > 1) {
      throw new CliError(
        "ENGINE_SECRET_AMBIGUOUS",
        EXIT.INVALID,
        `${record.id} 有多个密钥依赖，请用 --name 指定：${deps.map((dep) => dep.raw).join(", ")}`,
        { engine: record.id, secrets: deps.map((dep) => dep.raw) },
      );
    }
    return deps[0]!;
  }

  const matches = deps.filter((dep) => matchesSecretName(dep, name));
  if (matches.length === 0) {
    throw new CliError(
      "MISSING_SECRET",
      EXIT.INVALID,
      `${record.id} 没有名为 ${name} 的密钥依赖`,
      { engine: record.id, name },
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      "ENGINE_SECRET_AMBIGUOUS",
      EXIT.INVALID,
      `${record.id} 的密钥名 ${name} 命中多个依赖，请使用完整路径`,
      { engine: record.id, secrets: matches.map((dep) => dep.raw) },
    );
  }
  return matches[0]!;
}

async function runSecret(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const usageText =
    "用法: asg engines secret <engine> [--name <name>] --stdin | --clear";
  const [engineRaw, ...rest] = args;
  const engine = requireSingleEngine(engineRaw, usageText);

  const stdin = takeFlag(rest, "--stdin");
  const clear = takeFlag(rest, "--clear");
  const name = takeValue(rest, "--name");

  if (stdin && clear) usage("--stdin 与 --clear 只能二选一");
  if (!stdin && !clear) usage("需要 --stdin（从标准输入读取密钥）或 --clear");
  if (rest.length > 0) usage(usageText);

  const { ctx, record } = await resolveTarget(root, reporter, engine);
  const deps = secretDependencies(record);
  const dep = selectSecretDependency(record, deps, name);
  if (dep.kind === "extension" && dep.name && !EXTENSION_SECRET_NAME.test(dep.name)) {
    usage(`密钥名不合法：${dep.name}（要求 [a-z][a-z0-9_-]*）`);
  }

  const isSearxng = dep.kind === "searxng";
  const display = isSearxng ? dep.raw : `secrets.${dep.path.join(".")}`;

  let value: string | undefined;
  if (!clear) {
    value = (await stdinReader()).replace(/\r?\n$/, "");
    if (value.trim().length === 0) {
      usage("密钥不能为空；如需删除请使用 --clear");
    }
  }

  let changed = false;
  if (isSearxng) {
    // searxng 的密钥只能写在 settings.yml；清空时保留 api_key 字段，依赖声明不消失。
    const rendered = renderSearxngEngineApiKey(
      ctx.paths.searxngSettings,
      dep.name!,
      clear ? "" : value!,
    );
    if (rendered.text !== undefined) {
      writeFileAtomic(ctx.paths.searxngSettings, rendered.text);
      changed = true;
    }
  } else {
    const secretsDoc = readYamlDocument(ctx.paths.secrets);

    let text: string | undefined;
    if (clear) {
      if (deleteYamlPath(secretsDoc.doc, dep.path)) {
        text = documentToText(secretsDoc.doc);
      }
    } else {
      setYamlPath(secretsDoc.doc, dep.path, value!);
      text = documentToText(secretsDoc.doc);
    }

    if (text !== undefined) {
      // 先校验再写：secrets.yaml 用 0600，避免密钥对 group/other 可读。
      const { warnings } = validateConfigTexts({ configText: ctx.config.text, secretsText: text });
      for (const warning of warnings) reporter.info(`警告: ${warning}`);
      writeConfigFile(ctx.paths.secrets, text, 0o600);
      changed = true;
    }
  }

  await restart(root, reporter);

  const unchangedMessage = `密钥已是未设置状态: ${display}`;
  const changedMessage = clear
    ? `${isSearxng ? "已清空" : "已删除"}密钥: ${display}`
    : `已更新密钥: ${display}`;

  return {
    data: {
      engine: record.id,
      secret: display,
      changed: changed ? [display] : [],
      restart: "all",
      restarted: true,
    },
    human: [
      changed ? changedMessage : unchangedMessage,
      "服务已整栈重启并通过健康检查。",
      RESTART_NOTICE,
    ].join("\n"),
  };
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [sub, ...args] = rest;

  switch (sub) {
    case "list":
      return runList(root, reporter, args);
    case "enable":
      return runToggle(root, reporter, "enable", args);
    case "disable":
      return runToggle(root, reporter, "disable", args);
    case "route":
      return runRoute(root, reporter, args);
    case "secret":
      return runSecret(root, reporter, args);
    case undefined:
      throw new CliError(
        "UNEXPECTED",
        EXIT.USAGE,
        "用法: asg engines list|enable|disable|route|secret ...",
      );
    default:
      throw new CliError(
        "UNEXPECTED",
        EXIT.USAGE,
        `未知 engines 子命令：${sub}（可用: list | enable | disable | route | secret）`,
      );
  }
};
