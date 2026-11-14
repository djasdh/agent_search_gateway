/** 服务管理器检测与统一控制入口。
 *
 * 检测不做缓存：每次调用都现场执行平台命令或检查 pid 文件。
 * 外部命令统一通过可注入的 CommandRunner 执行，便于测试。
 */

import os from "node:os";
import process from "node:process";
import { CliError, EXIT } from "../errors.js";
import { rootPaths } from "../root.js";
import { isProcessAlive, readPidFile, runSync } from "../runtime/process.js";
import * as launchd from "./launchd.js";
import * as schtasks from "./schtasks.js";
import * as systemd from "./systemd.js";
import { currentUid } from "./paths.js";

export interface CommandOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** 注入点：默认使用同步 spawnSync，测试可替换为假的命令记录器。 */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => CommandResult;

export interface PlatformEnv {
  runner: CommandRunner;
  platform: string;
  home: string;
  uid: string;
}

export type ManagerMode = "systemd" | "launchd" | "schtasks" | "pid" | "none";

export interface ManagerDetection {
  mode: ManagerMode;
  registered: boolean;
  active: boolean;
  detail?: string;
}

export const defaultRunner: CommandRunner = (command, args, options = {}) => runSync(command, args, options);

export function createPlatformEnv(overrides: Partial<PlatformEnv> = {}): PlatformEnv {
  return {
    runner: overrides.runner ?? defaultRunner,
    platform: overrides.platform ?? process.platform,
    home: overrides.home ?? os.homedir(),
    uid: overrides.uid ?? currentUid(),
  };
}

function normalizePlatform(platform: string): "linux" | "darwin" | "win32" | "other" {
  const value = platform.toLowerCase();
  if (value === "linux" || value.startsWith("linux-")) return "linux";
  if (value === "darwin" || value === "mac" || value === "macos") return "darwin";
  if (value === "win32" || value === "windows") return "win32";
  return "other";
}

function detectPidMode(root: string, detail?: string): ManagerDetection {
  const pid = readPidFile(rootPaths(root).supervisorPid);
  const active = pid !== null && isProcessAlive(pid);
  return {
    mode: "pid",
    registered: false,
    active,
    detail: detail ?? (pid === null ? "无 supervisor.pid" : `pid ${pid}`),
  };
}

/** 返回当前生效的管理方式；未注册平台服务时回退到 pid 文件模式。 */
export function detectManager(root: string, env: PlatformEnv = createPlatformEnv()): ManagerDetection {
  const platform = normalizePlatform(env.platform);

  if (platform === "linux") {
    const result = systemd.detect(env);
    if (result.registered) {
      return { mode: "systemd", ...result };
    }
    return detectPidMode(root, result.detail);
  }

  if (platform === "darwin") {
    const result = launchd.detect(env);
    if (result.registered) {
      return { mode: "launchd", ...result };
    }
    return detectPidMode(root, result.detail);
  }

  if (platform === "win32") {
    const result = schtasks.detect(env);
    if (result.registered) {
      return { mode: "schtasks", ...result };
    }
    return detectPidMode(root, result.detail);
  }

  return detectPidMode(root);
}

function assertManaged(mode: ManagerMode): asserts mode is Exclude<ManagerMode, "pid" | "none"> {
  if (mode === "pid" || mode === "none") {
    throw new CliError(
      "SERVICE_NOT_REGISTERED",
      EXIT.FAIL,
      "当前没有注册系统服务，无法按服务管理器操作",
    );
  }
}

export function startService(mode: ManagerMode, env: PlatformEnv): void {
  assertManaged(mode);
  if (mode === "systemd") systemd.start(env);
  else if (mode === "launchd") launchd.start(env);
  else schtasks.start(env);
}

export function stopService(mode: ManagerMode, env: PlatformEnv): void {
  assertManaged(mode);
  if (mode === "systemd") systemd.stop(env);
  else if (mode === "launchd") launchd.stop(env);
  else schtasks.stop(env);
}

export function restartService(mode: ManagerMode, env: PlatformEnv): void {
  assertManaged(mode);
  if (mode === "systemd") systemd.restart(env);
  else if (mode === "launchd") launchd.restart(env);
  else schtasks.restart(env);
}
