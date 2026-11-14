/** Windows / 登录计划任务控制（schtasks，参数数组，不经过 shell）。 */

import { CliError, EXIT } from "../errors.js";
import type { CommandResult, PlatformEnv } from "./index.js";
import { WINDOWS_TASK_NAME } from "./paths.js";

export interface DetectResult {
  registered: boolean;
  active: boolean;
  detail?: string;
}

function detailOf(result: CommandResult): string {
  return (result.stderr || result.stdout || result.error || "").trim() || `退出码 ${result.status}`;
}

function assertOk(result: CommandResult, action: string): void {
  if (!result.ok) {
    throw new CliError(
      "START_FAILED",
      EXIT.FAIL,
      `${action}失败：${WINDOWS_TASK_NAME}（${detailOf(result)}）`,
    );
  }
}

export function detect(env: PlatformEnv): DetectResult {
  const query = env.runner("schtasks", ["/query", "/tn", WINDOWS_TASK_NAME], {
    timeoutMs: 10_000,
  });
  if (!query.ok) return { registered: false, active: false, detail: "未注册" };

  const listed = env.runner("schtasks", ["/query", "/tn", WINDOWS_TASK_NAME, "/fo", "LIST"], {
    timeoutMs: 10_000,
  });
  const text = listed.ok ? listed.stdout : "";
  const statusLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(Status|状态)\s*[:：]/i.test(line));
  const active = Boolean(
    statusLine && /[:：]\s*(Running|正在运行)/i.test(statusLine),
  );

  return {
    registered: true,
    active,
    detail: statusLine ?? undefined,
  };
}

export function start(env: PlatformEnv): void {
  assertOk(
    env.runner("schtasks", ["/run", "/tn", WINDOWS_TASK_NAME], { timeoutMs: 30_000 }),
    "启动计划任务",
  );
}

export function stop(env: PlatformEnv): void {
  assertOk(
    env.runner("schtasks", ["/end", "/tn", WINDOWS_TASK_NAME], { timeoutMs: 30_000 }),
    "停止计划任务",
  );
}

export function restart(env: PlatformEnv): void {
  // 未在运行时 /end 会失败，忽略即可，最终以 /run 是否成功为准。
  env.runner("schtasks", ["/end", "/tn", WINDOWS_TASK_NAME], { timeoutMs: 30_000 });
  assertOk(
    env.runner("schtasks", ["/run", "/tn", WINDOWS_TASK_NAME], { timeoutMs: 30_000 }),
    "重启计划任务",
  );
}
