/**
 * `asg engines list|enable|disable`。
 *
 * 统一目录见 config/engines.ts；本命令只负责参数解析、人类输出与一次整栈重启。
 */

import type { CommandFn, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { takeFlag } from "../args.js";
import { restartForConfig } from "../runtime/stack.js";
import { readLocalEngines, listEngines, setEngines, type EngineInfo } from "../config/engines.js";

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
    ? ["NAME", "KIND", "ENABLED", "AVAILABLE", "ROUTING", "SOURCE", "REQUIRES"]
    : ["NAME", "KIND", "ENABLED", "AVAILABLE", "ROUTING", "REQUIRES"];

  const rows = engines.map((engine) => {
    const base = [
      engine.name,
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
  if (args.some((arg) => arg.startsWith("-"))) {
    throw new CliError(
      "UNEXPECTED",
      EXIT.USAGE,
      `用法: asg engines ${action} <name...>（不接受选项）`,
    );
  }
  if (args.length === 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `用法: asg engines ${action} <name...>`);
  }

  const localNames = new Set(readLocalEngines(root).map((engine) => engine.name));
  const unknown = args.filter((name) => !localNames.has(name));
  let knownSearxng: string[] = [];
  if (unknown.length > 0) {
    // 本地没有的名字可能是 searxng 默认引擎：在线时用 /config 全量列表校验。
    let all: EngineInfo[];
    try {
      all = await listEngines(root, { all: true });
    } catch (error) {
      if (error instanceof CliError && error.code === "BACKEND_DOWN") {
        throw new CliError(
          "ENGINE_NOT_FOUND",
          EXIT.INVALID,
          `未知引擎：${unknown.join(", ")}（searxng 未运行，无法确认默认引擎）`,
          { engines: unknown },
        );
      }
      throw error;
    }
    const known = new Set(all.map((engine) => engine.name));
    const missing = unknown.filter((name) => !known.has(name));
    if (missing.length > 0) {
      throw new CliError("ENGINE_NOT_FOUND", EXIT.INVALID, `未知引擎：${missing.join(", ")}`, {
        engines: missing,
      });
    }
    knownSearxng = unknown;
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
