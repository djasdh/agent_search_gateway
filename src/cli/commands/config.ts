/**
 * `asg config get|set|validate`。
 *
 * 写入流程固定为：读 YAML Document（保留注释）→ 改值 → 临时文件校验
 * （复用 loadSettingsFrom）→ 备份 .bak + 原子替换 → 整栈重启。
 * 校验失败不写任何文件。
 */

import { existsSync } from "node:fs";
import process from "node:process";
import { takeFlag } from "../args.js";
import type { CommandFn, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { restartForConfig } from "../runtime/stack.js";
import {
  configPaths,
  documentToPlain,
  documentToText,
  getYamlPath,
  maskSecretValue,
  maskSecretsTree,
  parseConfigValue,
  readYamlDocument,
  resolveConfigPath,
  setYamlPath,
  writeConfigFile,
} from "../config/gateway.js";
import { validateConfigFiles, validateConfigTexts } from "../config/validate.js";
import { defaultSecrets } from "../../settings/secrets.js";

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

/** 测试钩子：替换整栈重启 / stdin 读取，传 null 恢复默认。 */
export function setRestartForTests(fn: RestartFn | null): void {
  restart = fn ?? defaultRestart;
}

export function setStdinReaderForTests(fn: StdinReader | null): void {
  stdinReader = fn ?? readStdinDefault;
}

function usage(message: string): never {
  throw new CliError("UNEXPECTED", EXIT.USAGE, message);
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function requireConfig(configPath: string): void {
  if (!existsSync(configPath)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到配置文件：${configPath}`);
  }
}

async function runGet(root: string, args: string[]): Promise<CommandResult> {
  const all = takeFlag(args, "--all");
  if (all && args.length > 0) usage("config get --all 不接受额外参数");
  if (!all && args.length !== 1) usage("用法: asg config get <path> | --all");

  const paths = configPaths(root);
  requireConfig(paths.config);
  const config = readYamlDocument(paths.config);
  const secrets = readYamlDocument(paths.secrets);
  const secretsPlain = secrets.exists ? documentToPlain(secrets.doc) : defaultSecrets();

  if (all) {
    const data = {
      ...documentToPlain(config.doc),
      secrets: maskSecretsTree(secretsPlain),
    };
    return { data, human: JSON.stringify(data, null, 2) };
  }

  const resolved = resolveConfigPath(args[0]!);
  if (resolved.target === "secrets") {
    const value =
      resolved.path.length === 0
        ? maskSecretsTree(secretsPlain)
        : maskSecretValue(getYamlPath(secrets.doc, resolved.path));
    return {
      data: { path: resolved.display, value },
      human: `${resolved.display}: ${formatValue(value)}`,
    };
  }

  const value = getYamlPath(config.doc, resolved.path);
  if (value === undefined) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, `配置中没有该路径：${resolved.display}`);
  }
  return {
    data: { path: resolved.display, value },
    human: `${resolved.display}: ${formatValue(value)}`,
  };
}

async function runSet(root: string, reporter: Reporter, args: string[]): Promise<CommandResult> {
  const stdin = takeFlag(args, "--stdin");
  const forceString = takeFlag(args, "--string");

  if (args.length < 1) usage("用法: asg config set <path> <value> [--string] | <path> --stdin");
  const resolved = resolveConfigPath(args[0]!);

  let value: unknown;
  if (resolved.target === "secrets") {
    if (!stdin) usage("secrets 只能通过 --stdin 设置（避免密钥进入 argv）");
    if (args.length !== 1) usage("config set secrets.<path> --stdin 不接受额外参数");
    value = (await stdinReader()).replace(/\r?\n$/, "");
  } else {
    if (stdin) usage("--stdin 只能用于 secrets.<path>");
    if (args.length !== 2) usage("用法: asg config set <path> <value> [--string]");
    value = parseConfigValue(args[1]!, forceString);
  }

  const paths = configPaths(root);
  requireConfig(paths.config);

  const config = readYamlDocument(paths.config);
  const secrets = readYamlDocument(paths.secrets);

  if (resolved.target === "secrets") {
    setYamlPath(secrets.doc, resolved.path, value);
  } else {
    setYamlPath(config.doc, resolved.path, value);
  }

  const configText = resolved.target === "config" ? documentToText(config.doc) : config.text;
  const secretsText =
    resolved.target === "secrets" ? documentToText(secrets.doc) : secrets.exists ? secrets.text : undefined;

  // 校验失败 → CONFIG_INVALID，目标文件保持原样（临时目录已清理）。
  const { warnings } = validateConfigTexts({ configText, secretsText });
  for (const warning of warnings) reporter.info(`警告: ${warning}`);

  const targetFile = resolved.target === "secrets" ? paths.secrets : paths.config;
  const targetText = resolved.target === "secrets" ? (secretsText as string) : configText;
  writeConfigFile(targetFile, targetText, resolved.target === "secrets" ? 0o600 : undefined);

  await restart(root, reporter);

  return {
    data: {
      changed: [resolved.display],
      restart: "all",
      restarted: true,
    },
    human: [
      `已更新 ${resolved.display}`,
      "服务已整栈重启并通过健康检查。",
      RESTART_NOTICE,
    ].join("\n"),
  };
}

async function runValidate(root: string, reporter: Reporter, args: string[]): Promise<CommandResult> {
  if (args.length !== 0) usage("用法: asg config validate");

  const { warnings } = validateConfigFiles(root);
  for (const warning of warnings) reporter.info(`警告: ${warning}`);

  return {
    data: { valid: true, warnings },
    human: ["配置校验通过。", ...warnings.map((warning) => `警告: ${warning}`)].join("\n"),
  };
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [sub, ...args] = rest;

  switch (sub) {
    case "get":
      return runGet(root, args);
    case "set":
      return runSet(root, reporter, args);
    case "validate":
      return runValidate(root, reporter, args);
    case undefined:
      usage("用法: asg config get|set|validate ...");
    default:
      usage(`未知 config 子命令：${sub}（可用: get | set | validate）`);
  }
};
