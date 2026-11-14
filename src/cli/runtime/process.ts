/** 进程与外部命令工具：pid 文件、存活判断、进程树信号、同步命令执行。 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export interface SyncResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface SyncOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** 同步执行外部命令；不经过 shell，失败不抛异常，统一返回结果。 */
export function runSync(command: string, args: string[], options: SyncOptions = {}): SyncResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 15_000,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    return {
      ok: false,
      status: null,
      stdout,
      stderr,
      error: result.error.message,
    };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout,
    stderr,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.ceil(ms)));
  });
}

function normalizePid(value: string | undefined): number | null {
  if (!value) return null;
  const pid = Number(value.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

export function readPidFile(file: string): number | null {
  try {
    return normalizePid(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 原子写入 pid 文件（临时文件 + rename）。 */
export function writePidFile(file: string, pid: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${pid}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function removePidFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 文件可能已被删除。
  }
}

/** pid 是否仍存活；EPERM 表示存在但无权限，视为存活。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EPERM");
  }
}

/**
 * 结束进程树。
 * Unix 优先对进程组发信号（supervisor 以 detached 启动，子进程在同一组）；
 * Windows 使用 taskkill /t /f。
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM", force = false): void {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    // 非 force 先用不带 /f 的 taskkill 结束进程树，宽限期后仍存活再 /f。
    const args = ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])];
    runSync("taskkill", args, { timeoutMs: 10_000 });
    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH" && !force) {
      // 进程组不存在时再尝试单个 pid。
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // 进程可能已经退出。
  }
}

/** 轮询等待进程退出；返回是否在超时内退出。 */
export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}
