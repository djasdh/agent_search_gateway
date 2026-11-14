/**
 * `asg adlist update [--level ads|ads+tracking|full]`。
 *
 * 下载 StevenBlack hosts → 原子写 data/adblock/hosts → 整栈重启。
 * 网关内存里的域名过滤集只在自身调度器拉取时刷新，外部写文件不会热更新，
 * 所以成功写入后必须重启。
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { takeValue } from "../args.js";
import type { CommandFn, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { restartForConfig } from "../runtime/stack.js";
import { rootPaths } from "../root.js";
import { getYamlPath, readYamlDocument, writeFileAtomic } from "../config/gateway.js";
import { HOSTS_SOURCES } from "../../filter/domain-filter.js";
import type { AdFilterLevel } from "../../settings/types.js";

export const ADLIST_TIMEOUT_MS = 60_000;

const LEVELS: readonly AdFilterLevel[] = ["off", "ads", "ads+tracking", "full"];

export type HostsFetcher = (url: string, timeoutMs: number) => Promise<string>;

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

function proxyEnvName(): string | null {
  for (const key of PROXY_KEYS) {
    if ((process.env[key] || "").trim()) return key;
  }
  return null;
}

/** Node fetch 不读取 HTTPS_PROXY；代理环境优先用 curl（会自动读取代理变量）。 */
function fetchWithCurl(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const curl = process.platform === "win32" ? "curl.exe" : "curl";
    const args = [
      "-fsSL",
      "--proto",
      "=https",
      "--connect-timeout",
      "20",
      "--max-time",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "-H",
      "User-Agent: agent-search-gateway-cli",
      url,
    ];
    const child = spawn(curl, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-1000);
    });
    child.once("error", (error) => reject(new Error(`curl 不可用：${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`curl 退出码 ${code}${stderr.trim() ? `：${stderr.trim()}` : ""}`));
    });
  });
}

async function fetchWithNode(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchHostsDefault(url: string, timeoutMs: number): Promise<string> {
  const proxy = proxyEnvName();
  const attempts = proxy ? [fetchWithCurl, fetchWithNode] : [fetchWithNode, fetchWithCurl];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt(url, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type RestartFn = (root: string, reporter: Reporter) => Promise<void>;
const defaultRestart: RestartFn = (root, reporter) => restartForConfig(root, reporter);

let restart: RestartFn = defaultRestart;
let fetchHosts: HostsFetcher = fetchHostsDefault;

/** 测试钩子：替换整栈重启 / hosts 下载，传 null 恢复默认。 */
export function setRestartForTests(fn: RestartFn | null): void {
  restart = fn ?? defaultRestart;
}

export function setHostsFetcherForTests(fn: HostsFetcher | null): void {
  fetchHosts = fn ?? fetchHostsDefault;
}

export function parseAdListLevel(raw: string): AdFilterLevel {
  const level = raw.trim();
  if (!(LEVELS as readonly string[]).includes(level)) {
    throw new CliError(
      "UNEXPECTED",
      EXIT.USAGE,
      `未知广告过滤 level：${raw}（可选: ads | ads+tracking | full | off）`,
    );
  }
  return level as AdFilterLevel;
}

/** 未传 --level 时读 gateway.yaml 的 ad_filter.level；缺省与旧脚本一致为 ads。 */
export function readConfiguredLevel(root: string): AdFilterLevel {
  const { doc } = readYamlDocument(rootPaths(root).config);
  const value = getYamlPath(doc, ["ad_filter", "level"]);
  if (value === undefined) return "ads";
  if (typeof value !== "string") {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, "ad_filter.level 必须是字符串");
  }
  return parseAdListLevel(value);
}

/** 有效 hosts 行数（与旧脚本的 grep 计数口径一致）。 */
export function countHostEntries(text: string): number {
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)\s+\S+/.test(line)) count += 1;
  }
  return count;
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [sub, ...args] = rest;
  if (sub !== "update") {
    throw new CliError(
      "UNEXPECTED",
      EXIT.USAGE,
      sub === undefined ? "用法: asg adlist update [--level ads|ads+tracking|full]" : `未知 adlist 子命令：${sub}`,
    );
  }

  const levelArg = takeValue(args, "--level");
  if (args.length > 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "用法: asg adlist update [--level ads|ads+tracking|full]");
  }

  const level = levelArg === undefined ? readConfiguredLevel(root) : parseAdListLevel(levelArg);
  const hostsPath = path.join(root, "data", "adblock", "hosts");

  if (level === "off") {
    return {
      data: { level, entries: 0, path: hostsPath, restart: "all", restarted: false },
      human: "level=off，无需更新广告列表。",
    };
  }

  const url = HOSTS_SOURCES[level];
  let text: string;
  try {
    text = await fetchHosts(url, ADLIST_TIMEOUT_MS);
  } catch (error) {
    throw new CliError(
      "DOWNLOAD_FAILED",
      EXIT.FAIL,
      `下载广告列表失败（${url}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = countHostEntries(text);
  writeFileAtomic(hostsPath, text);

  await restart(root, reporter);

  return {
    data: { level, entries, path: hostsPath, restart: "all", restarted: true },
    human: [
      `已更新广告列表（level=${level}，${entries} 条）：${hostsPath}`,
      "服务已整栈重启并通过健康检查。",
      "整栈重启会断开所有 MCP 连接。",
    ].join("\n"),
  };
};
