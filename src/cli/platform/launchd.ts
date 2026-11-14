/** macOS / LaunchAgent 控制。 */

import fs from "node:fs";
import { CliError, EXIT } from "../errors.js";
import type { CommandResult, PlatformEnv } from "./index.js";
import { LAUNCHD_LABEL, launchdDomain, launchdPlistPath } from "./paths.js";

export interface DetectResult {
  registered: boolean;
  active: boolean;
  detail?: string;
}

function target(env: PlatformEnv): string {
  return `${launchdDomain(env.uid)}/${LAUNCHD_LABEL}`;
}

function detailOf(result: CommandResult): string {
  return (result.stderr || result.stdout || result.error || "").trim() || `退出码 ${result.status}`;
}

function assertOk(result: CommandResult, action: string): void {
  if (!result.ok) {
    throw new CliError(
      "START_FAILED",
      EXIT.FAIL,
      `${action}失败：${LAUNCHD_LABEL}（${detailOf(result)}）`,
    );
  }
}

export function detect(env: PlatformEnv): DetectResult {
  const printed = env.runner("launchctl", ["print", target(env)], { timeoutMs: 5000 });
  const loaded = printed.ok;
  let active = false;
  let state: string | undefined;

  if (loaded) {
    const stateMatch = /state = ([^\n]+)/.exec(printed.stdout);
    if (stateMatch) state = stateMatch[1]!.trim();
    const hasPid = /pid = \d+/.test(printed.stdout);
    active = state === "running" || hasPid;
  }

  const registered = loaded || fs.existsSync(launchdPlistPath(env.home));
  return {
    registered,
    active,
    detail: state ?? (loaded ? "已加载" : "未加载"),
  };
}

export function start(env: PlatformEnv): void {
  assertOk(
    env.runner("launchctl", ["kickstart", target(env)], { timeoutMs: 30_000 }),
    "启动 launchd 服务",
  );
}

export function stop(env: PlatformEnv): void {
  assertOk(
    env.runner("launchctl", ["bootout", launchdDomain(env.uid), launchdPlistPath(env.home)], {
      timeoutMs: 30_000,
    }),
    "停止 launchd 服务",
  );
}

export function restart(env: PlatformEnv): void {
  assertOk(
    env.runner("launchctl", ["kickstart", "-k", target(env)], { timeoutMs: 60_000 }),
    "重启 launchd 服务",
  );
}
