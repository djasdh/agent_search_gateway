/** 两个 CLI 后端共用的执行层：起进程、收输出、解析 JSON 信封。 */

import { execFile } from "node:child_process";
import { BiliError, type CliResult } from "./types.js";
import { asRecord, type Json } from "./json.js";
import { errorFromEnvelope } from "./errors.js";

const MAX_BUFFER = 32 * 1024 * 1024;

/** 执行命令，永不 shell:true；超时/不存在都收敛成 CliResult。 */
export function runCli(command: string, args: string[], timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          failed: Boolean(err),
          exitCode: e && typeof e.code === "number" ? e.code : null,
          timedOut: Boolean(e?.killed),
          spawnError: e && typeof e.code === "string" ? e.code : undefined,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

/** kukemc 的 {ok,data,error} 信封；失败直接抛已映射的 BiliError。 */
export function envelope(stdout: string, stderr: string, what: string): Json {
  const body = asRecord(parseJson(stdout, stderr, what));
  if (!body) throw new BiliError("BILI_UNAVAILABLE", `${what}：返回不是 JSON 对象`);
  if (body.ok === false) throw errorFromEnvelope(body.error, what);
  const data = asRecord(body.data);
  if (!data) throw new BiliError("BILI_UNAVAILABLE", `${what}：响应缺少 data`);
  return data;
}

function parseJson(stdout: string, stderr: string, what: string): unknown {
  const text = stdout.trim();
  if (text === "") {
    throw new BiliError("BILI_UNAVAILABLE", `${what}：命令没有输出${tail(stderr)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BiliError("BILI_UNAVAILABLE", `${what}：输出不是合法 JSON${tail(stderr)}`);
  }
}

/** stderr 尾部，附在错误信息里便于判断。 */
export function tail(text: string, limit = 300): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return `（stderr: ${trimmed.slice(-limit)}）`;
}
