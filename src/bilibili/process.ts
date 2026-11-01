import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../logger.js";

/**
 * 托管子进程生命周期管理。
 *
 * 设计目标：
 * - 懒启动：构造时不 spawn，首次 `ensureStarted` 才拉起；
 * - 健康门禁：只有健康检查通过才算启动成功，避免把「进程还在、服务没起来」当成可用；
 * - 崩溃可恢复：子进程退出后下一次 `ensureStarted` 会重新拉起，但 1 分钟内最多 3 次；
 * - 不留孤儿：`dispose` 走 SIGTERM → 5s → SIGKILL，并在进程退出时兜底 SIGKILL。
 */

export interface ManagedProcessOptions {
  /** command[0] 为可执行文件，其余为参数（直接 spawn，不经过 shell）。 */
  command: string[];
  env?: Record<string, string>;
  logger?: Logger;
}

interface ExitState {
  child: ChildProcess;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stderr: string;
}

/** 健康检查轮询间隔。 */
const HEALTH_POLL_INTERVAL_MS = 200;
/** 单次健康检查的最长等待，避免一个挂起的请求拖过整个启动超时。 */
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
/** dispose 时 SIGTERM 的宽限期。 */
const SIGTERM_GRACE_MS = 5000;
/** SIGKILL 之后等待回收的时间。 */
const SIGKILL_WAIT_MS = 1000;
/** 重启窗口与次数上限。 */
const RESTART_WINDOW_MS = 60_000;
const MAX_STARTS_PER_WINDOW = 3;
/** 保留的 stderr 尾部长度（字符数）。 */
const STDERR_TAIL_CHARS = 4096;

/**
 * 进程退出时的兜底清单：模块级注册一次 `process.on("exit")`，
 * 避免每个实例重复挂监听器。
 */
const liveChildren = new Set<ChildProcess>();
let exitHookRegistered = false;

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("exit", () => {
    // exit 阶段只能做同步操作；SIGKILL 确保网关退出后不留孤儿进程。
    for (const child of liveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 退出阶段忽略一切错误
      }
    }
    liveChildren.clear();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待子进程退出；超时返回 false。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

/**
 * 健康检查：GET url，要求 HTTP 200 且响应体是 JSON；`{ ok: false }` 视为不健康。
 * 网络错误、超时、非 JSON 都按不健康处理（启动轮询会继续重试）。
 */
async function checkHealth(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status !== 200) return false;
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return false;
    }
    if (typeof body === "object" && body !== null && (body as Record<string, unknown>).ok === false) {
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class ManagedProcess {
  private readonly command: string[];
  private readonly env: Record<string, string>;
  private readonly logger?: Logger;

  private child: ChildProcess | null = null;
  private exitState: ExitState | null = null;
  private stderrTail = "";
  /** 启动时间戳（用于 1 分钟窗口限流）。 */
  private starts: number[] = [];
  /** 并发 ensureStarted 合并成同一个启动流程。 */
  private starting: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;
  private disposed = false;

  constructor(opts: ManagedProcessOptions) {
    this.command = opts.command;
    this.env = opts.env ?? {};
    this.logger = opts.logger;
    registerExitHook();
  }

  /** 当前仍在运行的子进程 pid；未启动/已退出时为 undefined。 */
  get pid(): number | undefined {
    return this.currentChild()?.pid;
  }

  /**
   * 确保子进程已启动且健康检查通过。
   * - 已在运行：直接返回；
   * - 未运行：spawn 后每 200ms 轮询 healthUrl，直到 startupTimeoutMs；
   * - 子进程提前退出：立即抛错并带上 stderr 摘要；
   * - 启动超时：SIGKILL 后抛错。
   */
  async ensureStarted(healthUrl: string, startupTimeoutMs: number): Promise<void> {
    if (this.disposed) {
      throw new Error("托管进程已释放，不能重新启动");
    }
    if (this.currentChild()) return;
    if (this.starting) return this.starting;

    const task = this.doStart(healthUrl, startupTimeoutMs);
    this.starting = task;
    try {
      await task;
    } finally {
      if (this.starting === task) this.starting = null;
    }
  }

  /**
   * 停止子进程：SIGTERM，5 秒后仍未退出则 SIGKILL。
   * 幂等：重复调用返回同一个 Promise。
   */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = this.doDispose();
    return this.disposing;
  }

  private async doStart(healthUrl: string, startupTimeoutMs: number): Promise<void> {
    const child = this.spawnChild();
    const deadline = Date.now() + startupTimeoutMs;

    while (true) {
      if (this.disposed) {
        await this.terminate(child, "SIGKILL", SIGKILL_WAIT_MS);
        throw new Error("托管进程已释放，启动已取消");
      }

      const earlyExit = this.exitStateFor(child);
      if (earlyExit) throw this.buildExitError(earlyExit);

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const healthy = await checkHealth(
        healthUrl,
        Math.min(HEALTH_REQUEST_TIMEOUT_MS, Math.max(100, remaining)),
      );

      if (healthy) {
        // 健康检查通过后进程恰好退出的情况也要报错，而不是返回一个已死的实例。
        const afterHealth = this.exitStateFor(child);
        if (afterHealth) throw this.buildExitError(afterHealth);
        this.logger?.debug(`Bilibili HTTP 后端托管进程已就绪（pid=${child.pid ?? "unknown"}）`);
        return;
      }

      const afterProbe = this.exitStateFor(child);
      if (afterProbe) throw this.buildExitError(afterProbe);

      if (Date.now() >= deadline) break;
      await sleep(Math.min(HEALTH_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    await this.terminate(child, "SIGKILL", SIGKILL_WAIT_MS);
    const stderr = this.latestStderr(child);
    throw new Error(
      `托管进程启动超时（${startupTimeoutMs}ms，健康检查 ${healthUrl}）` +
        (stderr ? `；stderr: ${stderr}` : ""),
    );
  }

  private spawnChild(): ChildProcess {
    const [executable, ...args] = this.command;
    if (!executable) {
      throw new Error("托管进程启动命令为空");
    }
    this.recordStartAttempt();

    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        env: { ...process.env, ...this.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      throw new Error(`托管进程启动失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.child = child;
    this.exitState = null;
    this.stderrTail = "";
    liveChildren.add(child);

    const logLine = (prefix: string, chunk: Buffer): void => {
      if (!this.logger) return;
      for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
        if (line.trim().length > 0) this.logger.debug(`${prefix}${line}`);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => logLine("[bili-http] ", chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      logLine("[bili-http] ", chunk);
    });

    child.on("error", (err: Error) => {
      liveChildren.delete(child);
      if (this.exitState?.child === child) return;
      const state: ExitState = {
        child,
        code: null,
        signal: null,
        error: err,
        stderr: this.stderrTail,
      };
      this.exitState = state;
      if (this.child === child) this.child = null;
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      liveChildren.delete(child);
      if (this.exitState?.child === child) return;
      const state: ExitState = {
        child,
        code,
        signal,
        stderr: this.stderrTail,
      };
      this.exitState = state;
      if (this.child === child) this.child = null;
      this.logger?.debug(
        `Bilibili HTTP 后端托管进程退出（${signal ? `signal=${signal}` : `code=${code ?? "unknown"}`}）`,
      );
    });

    return child;
  }

  private currentChild(): ChildProcess | null {
    const child = this.child;
    if (!child) return null;
    if (child.exitCode !== null || child.signalCode !== null) return null;
    if (this.exitState?.child === child) return null;
    return child;
  }

  private exitStateFor(child: ChildProcess): ExitState | null {
    return this.exitState?.child === child ? this.exitState : null;
  }

  private buildExitError(state: ExitState): Error {
    const reason = state.error
      ? `启动失败: ${state.error.message}`
      : state.signal
        ? `被信号 ${state.signal} 终止`
        : `退出码 ${state.code ?? "unknown"}`;
    const stderr = state.stderr.trim();
    return new Error(`托管进程提前退出（${reason}）${stderr ? `；stderr: ${stderr.slice(-800)}` : ""}`);
  }

  private latestStderr(child: ChildProcess): string {
    const state = this.exitStateFor(child);
    return (state?.stderr ?? this.stderrTail).trim().slice(-800);
  }

  private recordStartAttempt(): void {
    const now = Date.now();
    this.starts = this.starts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (this.starts.length >= MAX_STARTS_PER_WINDOW) {
      throw new Error(
        `托管进程 1 分钟内启动超过 ${MAX_STARTS_PER_WINDOW} 次，已停止重试（避免崩溃循环）`,
      );
    }
    this.starts.push(now);
  }

  private async terminate(
    child: ChildProcess,
    signal: NodeJS.Signals,
    timeoutMs: number,
  ): Promise<void> {
    if (this.exitStateFor(child)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      liveChildren.delete(child);
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // 进程可能刚好退出
    }
    await waitForExit(child, timeoutMs);
    liveChildren.delete(child);
    if (this.child === child) this.child = null;
  }

  private async doDispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (this.exitStateFor(child)) {
      liveChildren.delete(child);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      liveChildren.delete(child);
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // 已退出
    }
    // 宽限期内保留在兜底清单里：网关恰好在 dispose 期间退出时仍能 SIGKILL。
    const exited = await waitForExit(child, SIGTERM_GRACE_MS);
    if (exited) {
      liveChildren.delete(child);
      return;
    }

    this.logger?.warn("Bilibili HTTP 后端托管进程未在 5 秒内退出，发送 SIGKILL");
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
    await waitForExit(child, SIGKILL_WAIT_MS);
    liveChildren.delete(child);
  }
}
