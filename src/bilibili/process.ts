import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../logger.js";
import { asRecord } from "./json.js";
export interface ManagedProcessOptions { command: string[]; env?: Record<string, string>; logger?: Logger }
const POLL_MS = 200, PROBE_TIMEOUT_MS = 2000, SIGTERM_GRACE_MS = 5000;
const KILL_WAIT_MS = 1000, TAIL_CHARS = 2048;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const dead = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
/** 等待子进程退出；超时返回 false（定时器与监听器都会清理）。 */
function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (dead(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value: boolean): void => { clearTimeout(timer); child.off("exit", onExit); child.off("error", onExit); resolve(value); };
    const onExit = (): void => done(true);
    const timer = setTimeout(() => done(false), ms);
    child.once("exit", onExit); child.once("error", onExit);
  });
}
/** HTTP 200 且 JSON `ok !== false` 才算就绪；网络错误、超时、非 JSON 都视为未就绪。 */
async function healthy(url: string, ms: number): Promise<boolean> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(100, ms));
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.status === 200 && asRecord(await res.json())?.ok !== false;
  } catch { return false; } finally { clearTimeout(timer); }
}
async function signal(child: ChildProcess, sig: NodeJS.Signals, ms: number): Promise<boolean> {
  if (dead(child)) return true;
  try { child.kill(sig); } catch { return true; }
  return waitExit(child, ms);
}
/** 托管进程：懒启动、健康门禁、退出后可重拉、dispose 时 SIGTERM → 5s → SIGKILL。 */
export class ManagedProcess {
  private readonly command: string[]; private readonly env: Record<string, string>; private readonly logger?: Logger;
  private child: ChildProcess | null = null; private stderr = ""; private exitError?: Error;
  private starting: Promise<void> | null = null; private stopping: Promise<void> | null = null; private disposed = false;
  constructor(opts: ManagedProcessOptions) { this.command = opts.command; this.env = opts.env ?? {}; this.logger = opts.logger; }
  get pid(): number | undefined { return this.child && !dead(this.child) ? this.child.pid : undefined; }
  async ensureStarted(url: string, timeoutMs: number): Promise<void> {
    if (this.disposed) throw new Error("托管进程已释放，不能重新启动");
    if (this.pid !== undefined) return;
    if (this.starting) return this.starting;
    const task = this.start(url, timeoutMs);
    this.starting = task;
    try { await task; } finally { if (this.starting === task) this.starting = null; }
  }
  dispose(): Promise<void> { return (this.stopping ??= this.stop()); }
  private async start(url: string, timeoutMs: number): Promise<void> {
    const child = this.spawnChild();
    const deadline = Date.now() + timeoutMs;
    while (!this.disposed && !this.exitError && Date.now() < deadline) {
      if (await healthy(url, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())) && !this.exitError) {
        this.logger?.debug(`Bilibili HTTP 托管进程就绪（pid=${child.pid ?? "unknown"}）`);
        return;
      }
      await sleep(POLL_MS);
    }
    const early = this.exitError;
    await signal(child, "SIGKILL", KILL_WAIT_MS);
    const tail = this.stderr.trim().slice(-800);
    const suffix = tail ? `；stderr: ${tail}` : "";
    if (this.disposed) throw new Error("托管进程已释放，启动已取消");
    if (early) throw new Error(`${early.message}${suffix}`);
    throw new Error(`托管进程启动超时（${timeoutMs}ms，健康检查 ${url}）${suffix}`);
  }

  private spawnChild(): ChildProcess {
    const [executable, ...args] = this.command;
    if (!executable) throw new Error("托管进程启动命令为空");
    const child = spawn(executable, args, { env: { ...process.env, ...this.env }, shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.child = child; this.stderr = ""; this.exitError = undefined;
    child.stderr?.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-TAIL_CHARS); });
    const record = (reason: string): void => {
      if (this.child === child) this.child = null;
      if (!this.disposed) this.exitError = new Error(reason);
    };
    child.once("error", (err) => record(`启动失败：${err.message}`));
    child.once("exit", (code, sig) => record(sig ? `被信号 ${sig} 终止` : `退出码 ${code ?? "unknown"}`));
    return child;
  }

  private async stop(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    if (child && !(await signal(child, "SIGTERM", SIGTERM_GRACE_MS))) {
      this.logger?.warn("Bilibili HTTP 托管进程未在 5 秒内退出，发送 SIGKILL");
      await signal(child, "SIGKILL", KILL_WAIT_MS);
    }
  }
}
