/** Linux / systemd --user 用户单元控制。 */

import fs from "node:fs";
import { CliError, EXIT } from "../errors.js";
import type { CommandResult, PlatformEnv } from "./index.js";
import { SERVICE_NAME, systemdUnitPath } from "./paths.js";

export interface DetectResult {
  registered: boolean;
  active: boolean;
  detail?: string;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/)[0] ?? "").trim();
}

function detailOf(result: CommandResult): string {
  return (result.stderr || result.stdout || result.error || "").trim() || `退出码 ${result.status}`;
}

function assertOk(result: CommandResult, action: string): void {
  if (!result.ok) {
    throw new CliError(
      "START_FAILED",
      EXIT.FAIL,
      `${action}失败：systemctl ${SERVICE_NAME}（${detailOf(result)}）`,
    );
  }
}

export function detect(env: PlatformEnv): DetectResult {
  const activeResult = env.runner("systemctl", ["--user", "is-active", SERVICE_NAME], {
    timeoutMs: 5000,
  });
  const text = firstLine(activeResult.stdout || activeResult.stderr);
  const active = activeResult.ok && text === "active";
  if (active) return { registered: true, active: true, detail: text };

  // is-active 对未注册单元也可能返回 inactive；再用单元文件或 cat 判定注册状态。
  if (fs.existsSync(systemdUnitPath(env.home))) {
    return { registered: true, active: false, detail: text || undefined };
  }

  const cat = env.runner("systemctl", ["--user", "cat", SERVICE_NAME], { timeoutMs: 5000 });
  if (cat.ok) return { registered: true, active: false, detail: text || undefined };

  return { registered: false, active: false, detail: text || "未注册" };
}

export function start(env: PlatformEnv): void {
  assertOk(
    env.runner("systemctl", ["--user", "start", SERVICE_NAME], { timeoutMs: 30_000 }),
    "启动 systemd 服务",
  );
}

export function stop(env: PlatformEnv): void {
  assertOk(
    env.runner("systemctl", ["--user", "stop", SERVICE_NAME], { timeoutMs: 30_000 }),
    "停止 systemd 服务",
  );
}

export function restart(env: PlatformEnv): void {
  assertOk(
    env.runner("systemctl", ["--user", "restart", SERVICE_NAME], { timeoutMs: 60_000 }),
    "重启 systemd 服务",
  );
}
