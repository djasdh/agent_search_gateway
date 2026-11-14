/** asg serve 的 supervisor 实现（语义对齐原 scripts/start-all.mjs）。
 *
 * 区别：
 * - 子进程输出写入 data/logs/<service>.log，每行带 ISO 时间戳与 [service] 前缀；
 * - supervisor 自身消息写 data/logs/supervisor.log，不镜像到 stdout；
 * - 自己写/删 data/runtime/supervisor.pid。
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { rootPaths } from "../root.js";
import { loadLaunchConfig, type LaunchService } from "./launch.js";
import { probeUrl } from "./health.js";
import {
  removePidFile,
  runSync,
  sleep,
  writePidFile,
} from "./process.js";

export interface SupervisorOptions {
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  stopGraceMs?: number;
  monitorIntervalMs?: number;
  /** 仅用于测试注入；默认 process.platform。 */
  platform?: NodeJS.Platform;
}

interface ServiceRecord {
  svc: LaunchService;
  child: ChildProcess | null;
  external: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  healthy: boolean;
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_INTERVAL_MS = 1000;
const DEFAULT_STOP_GRACE_MS = 10_000;
const DEFAULT_MONITOR_INTERVAL_MS = 30_000;

function formatCommand(command: string[]): string {
  return command.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `信号 ${signal}`;
  if (typeof code === "number") return `退出码 ${code}`;
  return "未知状态";
}

class SupervisorLog {
  private readonly streams = new Map<string, fs.WriteStream>();

  constructor(private readonly dir: string) {}

  line(service: string, text: string): void {
    const safe = service.replace(/[^A-Za-z0-9._-]/g, "_") || "service";
    let stream = this.streams.get(safe);
    if (!stream) {
      fs.mkdirSync(this.dir, { recursive: true });
      stream = fs.createWriteStream(path.join(this.dir, `${safe}.log`), { flags: "a" });
      stream.on("error", () => {
        // 日志写失败不应拖垮 supervisor。
      });
      this.streams.set(safe, stream);
    }
    stream.write(`${new Date().toISOString()} [${service}] ${text}\n`);
  }

  async close(): Promise<void> {
    const streams = [...this.streams.values()];
    this.streams.clear();
    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            try {
              stream.end(() => resolve());
            } catch {
              resolve();
            }
          }),
      ),
    );
  }
}

/** 运行前台 supervisor，返回进程退出码（正常信号退出 0，异常退出 1）。 */
export async function runSupervisor(root: string, options: SupervisorOptions = {}): Promise<number> {
  // 配置错误直接抛 CliError（SCHEMA_MISMATCH / 退出码 4），由 asg 统一输出。
  const config = loadLaunchConfig(root);

  const paths = rootPaths(root);
  const platform = options.platform ?? process.platform;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const monitorIntervalMs = options.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;

  const logs = new SupervisorLog(paths.logsDir);
  const state = {
    shuttingDown: false,
    exitCode: 0,
    signalCount: 0,
  };
  let resolveShutdown: () => void = () => {};
  const shutdownDone = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const records: ServiceRecord[] = [];
  let monitorTimer: NodeJS.Timeout | null = null;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let pidWritten = false;
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

  const log = (service: string, message: string): void => logs.line(service, message);
  /** supervisor 自身消息：只写 supervisor.log，服务名放进正文。 */
  const sup = (service: string, message: string): void =>
    log("supervisor", `[${service}] ${message}`);

  function sendSignal(record: ServiceRecord, signal: NodeJS.Signals, force = false): void {
    const { child } = record;
    if (!child || record.exited) return;
    const pid = child.pid;

    if (platform === "win32") {
      if (force && pid) {
        runSync("taskkill", ["/pid", String(pid), "/t", "/f"], { timeoutMs: 10_000 });
      }
      try {
        child.kill(force ? "SIGKILL" : undefined);
      } catch {
        // 进程可能已经退出。
      }
      return;
    }

    if (!pid) {
      try {
        child.kill(signal);
      } catch {
        // 忽略已退出进程。
      }
      return;
    }

    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {
          // 忽略已退出进程。
        }
      }
    }
  }

  function startService(svc: LaunchService): ServiceRecord {
    const [command, ...args] = svc.command;
    const child = spawn(command!, args, {
      cwd: svc.cwd,
      env: { ...process.env, ...svc.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: platform !== "win32",
    });

    const record: ServiceRecord = {
      svc,
      child,
      external: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      healthy: true,
      exitPromise: Promise.resolve(),
      resolveExit: () => {},
    };
    record.exitPromise = new Promise<void>((resolve) => {
      record.resolveExit = resolve;
    });

    const pipe = (stream: NodeJS.ReadableStream | null, service: string): void => {
      if (!stream) return;
      const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
      reader.on("line", (line) => log(service, line));
    };
    pipe(child.stdout, svc.name);
    pipe(child.stderr, svc.name);

    child.on("error", (error) => {
      if (record.exited) return;
      record.exited = true;
      record.resolveExit();
      sup(svc.name, `启动失败：${error.message}`);
      if (!state.shuttingDown) {
        void initiateShutdown({ code: 1, reason: `启动失败：${svc.name}` });
      }
    });

    child.on("exit", (code, signal) => {
      if (record.exited) return;
      record.exited = true;
      record.exitCode = code;
      record.exitSignal = signal;
      record.resolveExit();
      const detail = describeExit(code, signal);

      if (state.shuttingDown) {
        sup(svc.name, `已退出（${detail}）`);
        return;
      }

      sup(svc.name, `意外退出（${detail}），正在停止其余服务`);
      const exitCode = typeof code === "number" && code !== 0 ? code : 1;
      void initiateShutdown({ code: exitCode, reason: `子进程退出：${svc.name}` });
    });

    return record;
  }

  async function waitOrTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function stopAll(signal: NodeJS.Signals): Promise<void> {
    const live = records
      .filter((record) => !record.external && record.child && !record.exited)
      .reverse();
    if (live.length === 0) return;

    for (const record of live) sendSignal(record, signal);

    await waitOrTimeout(Promise.all(live.map((record) => record.exitPromise)), stopGraceMs);

    const remaining = live.filter((record) => !record.exited);
    if (remaining.length === 0) return;

    log("supervisor", `${remaining.length} 个进程未在 ${stopGraceMs}ms 内退出，强制结束进程树`);
    for (const record of remaining) sendSignal(record, "SIGKILL", true);
    await waitOrTimeout(Promise.all(remaining.map((record) => record.exitPromise)), 3000);
  }

  async function initiateShutdown(options_: {
    code: number;
    reason?: string;
    signal?: NodeJS.Signals;
  }): Promise<void> {
    if (state.shuttingDown) return shutdownDone;

    state.shuttingDown = true;
    state.exitCode = Number.isInteger(options_.code) ? options_.code : 1;
    log(
      "supervisor",
      `开始停止所有服务${options_.reason ? `（${options_.reason}）` : ""}`,
    );

    try {
      await stopAll(options_.signal ?? "SIGTERM");
    } catch (error) {
      log(
        "supervisor",
        `停止服务时出错：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      log("supervisor", `全部服务已停止，退出码 ${state.exitCode}`);
      resolveShutdown();
    }

    return shutdownDone;
  }

  function installSignalHandlers(): void {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
      const handler = (): void => {
        if (state.shuttingDown) {
          state.signalCount += 1;
          if (state.signalCount >= 2) {
            log("supervisor", `再次收到 ${signal}，强制结束剩余进程`);
            for (const record of records) sendSignal(record, "SIGKILL", true);
          }
          return;
        }
        state.signalCount = 1;
        log("supervisor", `收到 ${signal}，开始优雅停止`);
        void initiateShutdown({ code: 0, reason: `信号 ${signal}`, signal });
      };
      try {
        process.on(signal, handler);
        signalHandlers.push({ signal, handler });
      } catch {
        // 某些平台不支持个别信号，忽略即可。
      }
    }
  }

  async function probeHealthy(url: string | null, timeoutMs = 2000): Promise<boolean> {
    if (!url) return true;
    return (await probeUrl(url, timeoutMs)).up;
  }

  async function waitForHealth(
    record: ServiceRecord,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<boolean> {
    const { svc } = record;
    const startedAt = Date.now();
    let nextNotice = 5000;
    let attempts = 0;

    while (Date.now() - startedAt < timeoutMs) {
      if (state.shuttingDown || record.exited) return false;
      attempts += 1;
      const remaining = timeoutMs - (Date.now() - startedAt);
      const probeTimeout = Math.max(200, Math.min(2000, remaining));
      if (await probeHealthy(svc.health, probeTimeout)) return true;
      if (state.shuttingDown || record.exited) return false;

      const elapsed = Date.now() - startedAt;
      if (elapsed >= nextNotice) {
        sup(
          svc.name,
          `仍在等待健康检查（已 ${Math.round(elapsed / 1000)} 秒，第 ${attempts} 次）：${svc.health}`,
        );
        nextNotice += 5000;
      }

      const wait = Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt)));
      if (wait > 0) await sleep(wait);
    }

    return false;
  }

  function startMonitor(): void {
    const externals = records.filter((record) => record.external && record.svc.health);
    if (externals.length === 0) return;

    let running = false;
    monitorTimer = setInterval(async () => {
      if (running || state.shuttingDown) return;
      running = true;
      try {
        for (const record of externals) {
          if (state.shuttingDown) return;
          const healthy = await probeHealthy(record.svc.health, 2000);
          if (record.healthy === healthy) continue;
          record.healthy = healthy;
          if (healthy) {
            sup(record.svc.name, `外部服务恢复健康：${record.svc.health}`);
          } else {
            sup(
              record.svc.name,
              `外部服务健康检查失败：${record.svc.health}（该进程不在本 supervisor 管理范围内）`,
            );
          }
        }
      } finally {
        running = false;
      }
    }, monitorIntervalMs);
    if (typeof monitorTimer.unref === "function") monitorTimer.unref();
  }

  try {
    for (const warning of config.warnings) log("supervisor", warning);

    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    writePidFile(paths.supervisorPid, process.pid);
    pidWritten = true;
    installSignalHandlers();

    log("supervisor", `项目根目录：${root}`);
    log("supervisor", `配置文件：${paths.launch}`);
    log("supervisor", `共 ${config.services.length} 个服务`);

    for (const svc of config.services) {
      if (state.shuttingDown) break;

      if (svc.health) {
        const alreadyHealthy = await probeHealthy(svc.health, 2000);
        if (state.shuttingDown) break;
        if (alreadyHealthy) {
          records.push({
            svc,
            child: null,
            external: true,
            exited: false,
            exitCode: null,
            exitSignal: null,
            healthy: true,
            exitPromise: Promise.resolve(),
            resolveExit: () => {},
          });
          sup(svc.name, `已在运行（${svc.health}），跳过启动并纳入监督`);
          continue;
        }
      }

      sup(svc.name, `启动：${formatCommand(svc.command)}`);
      const record = startService(svc);
      records.push(record);
      if (state.shuttingDown) break;

      if (!svc.health) {
        sup(svc.name, "未配置健康检查，视为已就绪");
        continue;
      }

      sup(
        svc.name,
        `等待健康检查：${svc.health}（最多 ${Math.round(healthTimeoutMs / 1000)} 秒）`,
      );
      const healthy = await waitForHealth(record, healthTimeoutMs, healthIntervalMs);
      if (!healthy) {
        if (state.shuttingDown) break;
        sup(
          svc.name,
          `健康检查超时（${Math.round(healthTimeoutMs / 1000)} 秒）：${svc.health}`,
        );
        await initiateShutdown({ code: 1, reason: `健康检查超时：${svc.name}` });
        break;
      }
      sup(svc.name, `健康检查通过：${svc.health}`);
    }

    if (state.shuttingDown) {
      await shutdownDone;
      return state.exitCode;
    }

    startMonitor();
    keepAliveTimer = setInterval(() => {}, 3_600_000);

    if (config.services.length === 0) {
      log("supervisor", "没有需要启动的服务，仅保持前台监督；按 Ctrl+C 退出");
    } else {
      log("supervisor", `全部 ${config.services.length} 个服务已就绪，进入监督模式`);
    }

    await shutdownDone;
    return state.exitCode;
  } catch (error) {
    log(
      "supervisor",
      `错误：${error instanceof Error ? error.message : String(error)}`,
    );
    if (!state.shuttingDown && records.length > 0) {
      await initiateShutdown({ code: 1, reason: "未预期错误" });
    }
    return state.shuttingDown ? state.exitCode : 1;
  } finally {
    if (monitorTimer) clearInterval(monitorTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    for (const { signal, handler } of signalHandlers) {
      process.off(signal, handler);
    }
    if (pidWritten) removePidFile(paths.supervisorPid);
    await logs.close();
  }
}
