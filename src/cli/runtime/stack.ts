/** 整栈状态探测与启停（status / start / stop / restart 的共同实现）。 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { Reporter } from "../output.js";
import { CliError, EXIT } from "../errors.js";
import { readEndpoints } from "../ports.js";
import { binAsgPath, exists, nodePath, releaseDir, rootPaths } from "../root.js";
import {
  createPlatformEnv,
  detectManager,
  restartService,
  startService,
  stopService,
  type ManagerDetection,
} from "../platform/index.js";
import { DEFAULT_PROBE_TIMEOUT_MS, probeFromHealth, probeGateway, probeUrl } from "./health.js";
import type { ServiceProbe } from "./health.js";
import {
  isProcessAlive,
  killProcessTree,
  readPidFile,
  sleep,
  waitForProcessExit,
} from "./process.js";

export type { ServiceProbe } from "./health.js";

export interface SupervisorInfo {
  managed: boolean;
  mode: "systemd" | "launchd" | "schtasks" | "pid" | "none";
  active: boolean;
}

export interface StackStatus {
  services: {
    gateway: ServiceProbe;
    searxng: ServiceProbe;
    flaresolverr: ServiceProbe;
  };
  supervisor: SupervisorInfo;
}

const DEFAULT_START_TIMEOUT_MS = 120_000;
const PID_WAIT_TIMEOUT_MS = 30_000;

function toSupervisorInfo(detection: ManagerDetection): SupervisorInfo {
  return {
    managed: detection.mode !== "pid" && detection.mode !== "none",
    mode: detection.mode,
    active: detection.active,
  };
}

/** 现场探测三个服务；gateway 在线时直接采用 /health 里的后端结果。 */
export async function probeStack(root: string): Promise<StackStatus> {
  const endpoints = readEndpoints(root);
  const timeout = DEFAULT_PROBE_TIMEOUT_MS;

  const gateway = await probeGateway(endpoints.gatewayPort, timeout);

  let searxng: ServiceProbe;
  let flaresolverr: ServiceProbe;
  if (gateway.probe.up && gateway.body) {
    // gateway 的 /health 已经汇总了两个后端，不再重复直探。
    searxng = probeFromHealth(gateway.body.searxng) ?? { up: true };
    flaresolverr = probeFromHealth(gateway.body.flaresolverr) ?? { up: true };
  } else {
    [searxng, flaresolverr] = await Promise.all([
      probeUrl(`${endpoints.searxngUrl}/healthz`, timeout),
      probeUrl(`${endpoints.flaresolverrUrl}/`, timeout),
    ]);
  }

  return {
    services: { gateway: gateway.probe, searxng, flaresolverr },
    supervisor: toSupervisorInfo(detectManager(root)),
  };
}

/** 轮询 gateway /health，直到健康或超时；超时抛 HEALTH_TIMEOUT。 */
export async function waitGateway(root: string, timeoutMs = DEFAULT_START_TIMEOUT_MS): Promise<void> {
  const { gatewayPort } = readEndpoints(root);
  const deadline = Date.now() + Math.max(0, timeoutMs);

  for (;;) {
    const { probe } = await probeGateway(gatewayPort, Math.min(DEFAULT_PROBE_TIMEOUT_MS, 1000));
    if (probe.up) return;

    if (Date.now() >= deadline) {
      throw new CliError(
        "HEALTH_TIMEOUT",
        EXIT.FAIL,
        `等待 gateway 健康检查超时（${Math.round(timeoutMs / 1000)} 秒）：http://127.0.0.1:${gatewayPort}/health`,
        { last_error: probe.error },
      );
    }
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  }
}

async function waitGatewayDown(root: string, timeoutMs: number): Promise<boolean> {
  const { gatewayPort } = readEndpoints(root);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const { probe } = await probeGateway(gatewayPort, 1000);
    if (!probe.up) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

function serveInvocation(root: string): { command: string; args: string[] } {
  const command = nodePath(root);
  const bin = binAsgPath(root);
  if (exists(bin)) {
    return { command, args: [bin, "serve"] };
  }

  // 开发环境（未安装 bin/asg.mjs）回退到当前 release 的 CLI 入口。
  try {
    const cli = path.join(releaseDir(root), "dist", "cli", "asg.js");
    if (exists(cli)) return { command, args: [cli, "serve", "--root", root] };
  } catch {
    // release 目录不存在，走下面的错误。
  }

  throw new CliError("START_FAILED", EXIT.FAIL, `未找到启动入口：${bin}`);
}

async function waitForSupervisorPid(
  file: string,
  timeoutMs: number,
  hasExited?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const pid = readPidFile(file);
    if (pid !== null && isProcessAlive(pid)) return true;
    if (hasExited?.()) return false;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** 启动整栈；已健康时返回 already_running，不重复启动。 */
export async function startStack(
  root: string,
  reporter: Reporter,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
): Promise<{ state: "started" | "already_running"; supervisor: SupervisorInfo }> {
  const env = createPlatformEnv();
  const detection = detectManager(root, env);
  const { gatewayPort } = readEndpoints(root);
  const gateway = await probeGateway(gatewayPort);

  if (gateway.probe.up) {
    return {
      state: "already_running",
      supervisor: toSupervisorInfo(detectManager(root, env)),
    };
  }

  if (detection.mode === "pid" || detection.mode === "none") {
    if (detection.active) {
      reporter.info("supervisor 已在运行（pid 模式），等待 gateway 健康检查");
    } else {
      const invocation = serveInvocation(root);
      reporter.info(`以 pid 模式启动 supervisor：${invocation.command} ${invocation.args.join(" ")}`);
      const child = spawn(invocation.command, invocation.args, {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      child.on("error", (error) => {
        reporter.info(`supervisor 进程启动失败：${error.message}`);
      });
      child.unref();

      const pidSeen = await waitForSupervisorPid(
        rootPaths(root).supervisorPid,
        Math.min(PID_WAIT_TIMEOUT_MS, Math.max(1000, timeoutMs)),
        () => child.exitCode !== null || child.signalCode !== null,
      );
      if (!pidSeen) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new CliError(
            "START_FAILED",
            EXIT.FAIL,
            `supervisor 启动后立即退出（${child.exitCode ?? child.signalCode}）`,
          );
        }
        reporter.info("等待 data/runtime/supervisor.pid 超时，继续等待 gateway 健康检查");
      }
    }
  } else {
    if (detection.active) {
      // 服务管理器认为进程活着，但 gateway 不健康：重启整栈。
      reporter.info(`通过 ${detection.mode} 重启整栈（gateway 未就绪）`);
      restartService(detection.mode, env);
    } else {
      reporter.info(`通过 ${detection.mode} 启动整栈`);
      startService(detection.mode, env);
    }
  }

  await waitGateway(root, timeoutMs);
  return {
    state: "started",
    supervisor: toSupervisorInfo(detectManager(root, env)),
  };
}

/** 停止整栈；未运行时返回 already_stopped。 */
export async function stopStack(
  root: string,
  reporter: Reporter,
): Promise<{ state: "stopped" | "already_stopped" }> {
  const env = createPlatformEnv();
  const detection = detectManager(root, env);

  if (detection.mode !== "pid" && detection.mode !== "none") {
    const { gatewayPort } = readEndpoints(root);
    const gateway = await probeGateway(gatewayPort);
    if (!detection.active && !gateway.probe.up) {
      return { state: "already_stopped" };
    }
    reporter.info(`通过 ${detection.mode} 停止整栈`);
    stopService(detection.mode, env);
    await waitGatewayDown(root, 20_000);
    return { state: "stopped" };
  }

  const pid = readPidFile(rootPaths(root).supervisorPid);
  if (pid === null || !isProcessAlive(pid)) {
    return { state: "already_stopped" };
  }

  reporter.info(`停止 supervisor（pid ${pid}）`);
  killProcessTree(pid, "SIGTERM");
  const exited = await waitForProcessExit(pid, 10_000, 100);
  if (!exited) {
    reporter.info(`supervisor 未在 10 秒内退出，强制结束进程树（pid ${pid}）`);
    killProcessTree(pid, "SIGKILL", true);
    await waitForProcessExit(pid, 3_000, 100);
  }
  return { state: "stopped" };
}

/** 重启整栈；未运行时等同 start。 */
export async function restartStack(
  root: string,
  reporter: Reporter,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
): Promise<{ state: "started" | "already_running"; supervisor: SupervisorInfo }> {
  const env = createPlatformEnv();
  const detection = detectManager(root, env);
  const { gatewayPort } = readEndpoints(root);
  const gateway = await probeGateway(gatewayPort);
  const running = detection.active || gateway.probe.up;

  if (!running) {
    return startStack(root, reporter, timeoutMs);
  }

  if (detection.mode === "pid" || detection.mode === "none") {
    await stopStack(root, reporter);
    return startStack(root, reporter, timeoutMs);
  }

  reporter.info(`通过 ${detection.mode} 重启整栈`);
  restartService(detection.mode, env);
  await waitGateway(root, timeoutMs);
  return {
    state: "started",
    supervisor: toSupervisorInfo(detectManager(root, env)),
  };
}

/** 配置文件/引擎/广告列表写入后的整栈重启：restart 已包含等待 gateway 健康。 */
export async function restartForConfig(root: string, reporter: Reporter): Promise<void> {
  await restartStack(root, reporter);
}
