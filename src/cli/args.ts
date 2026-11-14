/** 极简参数解析：只认全局参数，其余原样交给子命令。 */

import { CliError, EXIT } from "./errors.js";

export interface Globals {
  root?: string;
  json: boolean;
  jsonl: boolean;
  help: boolean;
  version: boolean;
}

export interface Invocation {
  globals: Globals;
  command?: string;
  rest: string[];
}

const GLOBAL_FLAGS = new Set(["--json", "--jsonl", "-h", "--help", "-v", "--version"]);

/** 解析 argv：全局参数可以出现在任意位置，第一个剩余 token 是子命令。 */
export function parseInvocation(argv: string[]): Invocation {
  const globals: Globals = {
    json: false,
    jsonl: false,
    help: false,
    version: false,
  };
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError("UNEXPECTED", EXIT.USAGE, "--root 需要一个目录");
      }
      globals.root = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      globals.root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--json") {
      globals.json = true;
      continue;
    }
    if (arg === "--jsonl") {
      globals.jsonl = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      globals.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      // 只把命令 token 之前的 --version 当作全局选项；命令之后的留给子命令
      //（例如 `asg update apply --version 0.3.0`）。
      if (remaining.length === 0) {
        globals.version = true;
        continue;
      }
    }

    remaining.push(arg);
  }

  if (globals.json && globals.jsonl) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "--json 与 --jsonl 不能同时使用");
  }

  const [command, ...rest] = remaining;
  return { globals, command, rest };
}

/** 取出带值的参数（同时支持 --name value 与 --name=value），返回 undefined 表示未提供。 */
export function takeValue(rest: string[], name: string): string | undefined {
  const index = rest.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return undefined;
  const arg = rest[index]!;
  if (arg.startsWith(`${name}=`)) {
    rest.splice(index, 1);
    return arg.slice(name.length + 1);
  }
  const value = rest[index + 1];
  if (value === undefined) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `${name} 需要一个值`);
  }
  rest.splice(index, 2);
  return value;
}

/** 取出布尔开关。 */
export function takeFlag(rest: string[], ...names: string[]): boolean {
  for (const name of names) {
    const index = rest.indexOf(name);
    if (index !== -1) {
      rest.splice(index, 1);
      return true;
    }
  }
  return false;
}

/** 取出数字参数。 */
export function takeNumber(rest: string[], name: string): number | undefined {
  const raw = takeValue(rest, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `${name} 需要一个数字`);
  }
  return value;
}
