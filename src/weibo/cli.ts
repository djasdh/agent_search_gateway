/** OpenCLI 执行层：起进程、收输出、按 sysexits 映射错误。 */

import type { Logger } from "../logger.js";
import { runCliProcess, type CliResult } from "../fetch/channels/index.js";
import { WeiboError } from "./types.js";

const MAX_BUFFER = 4 * 1024 * 1024;

/** 执行 opencli，永不 shell:true；超时/不存在都收敛成 CliResult。 */
export function runCli(command: string, args: string[], timeoutMs: number): Promise<CliResult> {
  return runCliProcess(command, args, { timeoutMs, maxBuffer: MAX_BUFFER });
}

function tail(text: string, limit = 300): string {
  const trimmed = text.trim();
  return trimmed === "" ? "" : `（stderr: ${trimmed.slice(-limit)}）`;
}

/** CLI 失败 → 网关错误码。OpenCLI 使用 sysexits：66/69/75/77/78。 */
export function mapCliFailure(result: CliResult, command: string, what: string): WeiboError {
  if (result.spawnError === "ENOENT") {
    return new WeiboError(
      "WEIBO_UNAVAILABLE",
      `spawn ${command} ENOENT`,
      `安装 OpenCLI（npm install -g @jackwener/opencli）或修改 weibo.cli.command`,
    );
  }
  if (result.timedOut) {
    return new WeiboError("WEIBO_TIMEOUT", `${what}：命令超时（${command}）`, "调大 weibo.cli.timeout_ms");
  }

  const detail = result.stderr.trim().slice(-300);
  switch (result.exitCode) {
    case 66:
      return new WeiboError("WEIBO_EMPTY", `${what}：没有结果`);
    case 69:
      return new WeiboError(
        "WEIBO_BRIDGE_DOWN",
        `${what}：OpenCLI Browser Bridge 未连接`,
        "启动 Chrome/Browser Bridge，或先运行 opencli doctor",
      );
    case 75:
      return new WeiboError("WEIBO_TIMEOUT", `${what}：浏览器命令超时`, "调大 weibo.cli.timeout_ms");
    case 77:
      return new WeiboError(
        "WEIBO_AUTH_REQUIRED",
        `${what}：微博未登录`,
        "在 Chrome 登录 weibo.com（或运行 opencli weibo login）后重试",
      );
    case 78:
      return new WeiboError("WEIBO_CONFIG", `${what}：OpenCLI 配置错误`, "运行 opencli doctor 检查");
    default:
      break;
  }

  if (/login|not_logged|未登录|auth required/i.test(detail)) {
    return new WeiboError(
      "WEIBO_AUTH_REQUIRED",
      `${what}：微博未登录`,
      "在 Chrome 登录 weibo.com 后重试",
      detail,
    );
  }
  return new WeiboError(
    "WEIBO_UNAVAILABLE",
    `${what}：${command} 退出码 ${result.exitCode ?? "unknown"}${tail(result.stderr)}`,
  );
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("[") && !text.startsWith("{")) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

/** 解析 `-f json` 输出；兼容 `{ok,data}` 信封与直接数组/对象。 */
export function parseCliJson(result: CliResult, command: string, what: string): unknown {
  const text = result.stdout.trim();
  if (text === "") {
    throw new WeiboError("WEIBO_EMPTY", `${what}：命令没有输出${tail(result.stderr)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WeiboError(
      "WEIBO_BAD_JSON",
      `${what}：输出不是合法 JSON（前 200 字符：${text.slice(0, 200)}）`,
    );
  }

  if (body && typeof body === "object" && "ok" in body) {
    const envelope = body as { ok?: unknown; data?: unknown; error?: unknown };
    if (envelope.ok === false) {
      const error = (envelope.error ?? {}) as { code?: unknown; message?: unknown; hint?: unknown };
      const code = typeof error.code === "string" ? error.code : "";
      const message = typeof error.message === "string" ? error.message : `${what} 失败`;
      const hint = typeof error.hint === "string" ? error.hint : undefined;
      if (/auth|login|未登录/i.test(`${code} ${message}`)) {
        throw new WeiboError("WEIBO_AUTH_REQUIRED", message, hint);
      }
      throw new WeiboError("WEIBO_UNAVAILABLE", message, hint, error);
    }
    if ("data" in envelope) return envelope.data;
  }

  return body;
}

/** post 的 `[{field,value}]` 行 → 对象；其它动作原样返回。 */
export function normalizePostRows(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      if (typeof record.field !== "string") continue;
      out[record.field] = parseMaybeJson(record.value);
    }
    return out;
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  throw new WeiboError("WEIBO_BAD_JSON", "weibo post 返回结构异常");
}

/** 执行并解析；失败统一抛 WeiboError。 */
export async function runOpencli<T = unknown>(
  command: string,
  args: string[],
  timeoutMs: number,
  what: string,
  logger?: Logger,
): Promise<T> {
  logger?.debug(`weibo cli: ${command} ${args.join(" ")}`);
  const result = await runCli(command, args, timeoutMs);
  if (result.failed) throw mapCliFailure(result, command, what);
  return parseCliJson(result, command, what) as T;
}
