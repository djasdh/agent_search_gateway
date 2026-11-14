/**
 * `asg engines list|enable|disable`。
 *
 * 统一目录见 `src/cli/engines/`；本命令只负责参数解析、人类输出与一次整栈重启。
 */

import type { CommandFn, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { takeFlag } from "../args.js";
import { restartForConfig } from "../runtime/stack.js";
import {
  listEngines,
  parseEngineRef,
  readLocalEngines,
  setEngines,
  type EngineInfo,
} from "../config/engines.js";

const RESTART_NOTICE = "整栈重启会断开所有 MCP 连接。";

type RestartFn = (root: string, reporter: Reporter) => Promise<void>;
const defaultRestart: RestartFn = (root, reporter) => restartForConfig(root, reporter);
let restart: RestartFn = defaultRestart;

/** 测试钩子：替换整栈重启，传 null 恢复默认。 */
export function setRestartForTests(fn: RestartFn | null): void {
  restart = fn ?? defaultRestart;
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

async function runList(root: string, args: string[]): Promise<CommandResult> {
  const all = takeFlag(args, "--all");
  if (args.length > 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "用法: asg engines list [--all]");
  }

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

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [sub, ...args] = rest;

  switch (sub) {
    case "list":
      return runList(root, args);
    case "enable":
      return runToggle(root, reporter, "enable", args);
    case "disable":
      return runToggle(root, reporter, "disable", args);
    case undefined:
      throw new CliError("UNEXPECTED", EXIT.USAGE, "用法: asg engines list|enable|disable ...");
    default:
      throw new CliError(
        "UNEXPECTED",
        EXIT.USAGE,
        `未知 engines 子命令：${sub}（可用: list | enable | disable）`,
      );
  }
};
