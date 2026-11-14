/** asg update check|apply */

import { takeValue } from "../args.js";
import type { CommandFn } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { runUpdate, type UpdateAction } from "../deps/update.js";

const USAGE = `用法: asg update <check|apply> [--version <v>]

  check              查询是否有可用更新
  apply              下载、校验、切换版本并重启；失败自动回滚
  apply --version v  安装指定版本

更新期间整栈会重启，MCP 连接会短暂断开。`;

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [subcommand, ...args] = rest;

  if (!subcommand) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, USAGE);
  }
  if (subcommand === "-h" || subcommand === "--help") {
    return { data: { usage: USAGE }, human: USAGE };
  }
  if (subcommand !== "check" && subcommand !== "apply") {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `未知子命令：${subcommand}\n\n${USAGE}`);
  }

  const version = takeValue(args, "--version");
  if (args.length > 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `未知参数：${args.join(" ")}\n\n${USAGE}`);
  }
  if (version !== undefined && subcommand === "check") {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "--version 只用于 apply");
  }

  const result = await runUpdate({
    root,
    action: subcommand as UpdateAction,
    ...(version === undefined ? {} : { version }),
    reporter,
  });

  const human =
    subcommand === "check"
      ? result.up_to_date
        ? result.current_version && result.version && result.current_version !== result.version
          ? `当前 ${result.current_version}，已不低于最新发布 ${result.version}。`
          : `已是最新版本${result.version ? `（${result.version}）` : ""}。`
        : `有可用更新${result.current_version ? `：${result.current_version}` : ""} → ${result.version ?? "未知"}。`
      : `更新完成${result.version ? `（目标版本 ${result.version}）` : ""}，整栈已重启。`;

  return { data: result, human };
};
