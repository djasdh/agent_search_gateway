/**
 * 统一 CLI 进程执行：bilibili / weibo 等所有 CLI 通道共用。
 *
 * 永不 `shell: true`；超时、命令不存在、非零退出都收敛成 `CliResult`，
 * 由各后端自己映射成业务错误码。
 */
import { execFile } from "node:child_process";
import type { CliResult, CliRunOptions } from "./types.js";

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export function runCliProcess(
  command: string,
  args: readonly string[],
  opts: CliRunOptions,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
        env: opts.env ?? process.env,
        cwd: opts.cwd,
      },
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
