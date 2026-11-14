#!/usr/bin/env node
/** asg CLI 入口：解析全局参数、分发命令、统一输出与退出码。 */

import process from "node:process";
import { parseInvocation } from "./args.js";
import type { CommandFn } from "./context.js";
import { CliError, EXIT, asCliError } from "./errors.js";
import { Reporter } from "./output.js";
import { resolveRoot, version } from "./root.js";

const USAGE = `用法: asg <命令> [选项]

命令:
  status                      三个服务的现场探测
  start | stop | restart      整栈启停
  serve                       前台 supervisor（供服务管理器调用）
  logs [service...] [-f]      日志；默认合并 gateway + supervisor
  config get|set|validate      gateway.yaml / secrets.yaml
  engines list|enable|disable  搜索引擎（searxng + 网关原生源）
  plugins list|install|remove  外部后端
  browser status|install       Playwright 浏览器
  adlist update               广告过滤列表
  update check|apply          自更新
  doctor                      环境与配置检查

全局选项:
  --root <dir>                安装根（默认向上查找 gateway.yaml）
  --json                      输出一个 JSON result
  --jsonl                     NDJSON 事件流，最后一行为 result
  -h, --help                  显示帮助
  -v, --version               显示版本
`;

type Loader = () => Promise<CommandFn>;

const COMMANDS: Record<string, Loader> = {
  status: () => import("./commands/status.js").then((m) => m.run),
  start: () => import("./commands/start.js").then((m) => m.run),
  stop: () => import("./commands/stop.js").then((m) => m.run),
  restart: () => import("./commands/restart.js").then((m) => m.run),
  serve: () => import("./commands/serve.js").then((m) => m.run),
  logs: () => import("./commands/logs.js").then((m) => m.run),
  config: () => import("./commands/config.js").then((m) => m.run),
  engines: () => import("./commands/engines.js").then((m) => m.run),
  plugins: () => import("./commands/plugins.js").then((m) => m.run),
  browser: () => import("./commands/browser.js").then((m) => m.run),
  adlist: () => import("./commands/adlist.js").then((m) => m.run),
  update: () => import("./commands/update.js").then((m) => m.run),
  doctor: () => import("./commands/doctor.js").then((m) => m.run),
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    const cliError = asCliError(error);
    process.stderr.write(`${cliError.message}\n\n${USAGE}`);
    return cliError.exitCode;
  }

  const { globals, command, rest } = invocation;
  if (globals.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }

  const reporter = new Reporter({ json: globals.json, jsonl: globals.jsonl });

  if (globals.version) {
    const root = resolveRoot(globals.root);
    process.stdout.write(`${version(root)}\n`);
    return EXIT.OK;
  }

  if (!command) {
    process.stdout.write(USAGE);
    return EXIT.USAGE;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    reporter.info(`未知命令: ${command}\n\n${USAGE}`);
    return EXIT.USAGE;
  }

  const root = resolveRoot(globals.root);
  // 带子命令的顶层命令在输出里带上子命令（config.set / engines.list ...）。
  const SUBCOMMANDS = new Set(["config", "engines", "plugins", "browser", "adlist", "update"]);
  const subcommand = SUBCOMMANDS.has(command) ? rest[0] : undefined;
  const resultName = subcommand ? `${command}.${subcommand}` : command;

  try {
    const run = await loader();
    const result = await run({ root, reporter, rest });
    reporter.result(
      { schema_version: 1, ok: result.ok ?? true, command: resultName, data: result.data },
      result.human,
    );
    return result.exitCode ?? EXIT.OK;
  } catch (error) {
    const cliError = asCliError(error);
    // 只有真正的内部失败（退出码 1）才打印堆栈；参数错误 / 校验失败是正常流程。
    if (
      cliError.code === "UNEXPECTED" &&
      cliError.exitCode === EXIT.FAIL &&
      error instanceof Error &&
      error.stack
    ) {
      reporter.info(error.stack);
    }
    reporter.result({
      schema_version: 1,
      ok: false,
      command: resultName,
      error: {
        code: cliError.code,
        message: cliError.message,
        ...(cliError.details === undefined ? {} : { details: cliError.details }),
      },
    });
    return cliError.exitCode;
  }
}

const invoked = process.argv[1] ? process.argv[1] : "";
if (invoked.endsWith("asg.js") || invoked.endsWith("asg.ts")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

export { CliError, EXIT };
