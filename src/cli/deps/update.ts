/** 自更新：转调 release 内的 scripts/self-update/cli.mjs，不重复实现下载/校验/回滚。 */

import path from "node:path";
import process from "node:process";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { exists, nodePath, releaseDir } from "../root.js";
import { forwardChildLine, spawnStream, type StreamRunner } from "./plugins.js";

export type UpdateAction = "check" | "apply";

export interface UpdateResult {
  action: UpdateAction;
  version: string | null;
  /** 仅 check：当前安装版本（未安装为 null）。 */
  current_version?: string | null;
  /** 仅 check：是否已是最新。 */
  up_to_date?: boolean;
  restarted: boolean;
}

/** 命令行参数映射：check 追加 --check，apply 追加 --version；两者都追加 --jsonl。 */
export function updateArgs(action: UpdateAction, version?: string): string[] {
  const args: string[] = [];
  if (action === "check") {
    args.push("--check");
  } else if (version) {
    args.push("--version", version);
  }
  args.push("--jsonl");
  return args;
}

export interface UpdateOptions {
  root: string;
  action: UpdateAction;
  version?: string;
  reporter: Reporter;
  runner?: StreamRunner;
}

/** 子进程事件里的“已回滚”标记：self-update 在回滚时会输出包含“回滚”的日志。 */
function isRollbackEvent(event: Record<string, unknown>): boolean {
  const text = [event.event, event.message, event.line]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return event.event === "rollback" || text.includes("回滚到");
}

export async function runUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const { root, reporter, action } = options;
  const release = releaseDir(root);
  const cli = path.join(release, "scripts", "self-update", "cli.mjs");
  if (!exists(cli)) {
    throw new CliError("UPDATE_FAILED", EXIT.FAIL, `未找到自更新脚本：${cli}`);
  }

  const runner = options.runner ?? spawnStream;
  let rolledBack = false;
  let restarted = action === "apply";
  const check: { target?: string; current?: string | null; upToDate?: boolean } = {};
  const result = await runner(nodePath(root), [cli, ...updateArgs(action, options.version)], {
    cwd: root,
    env: process.env,
    onLine: (line, stream) => {
      forwardChildLine(reporter, line, "update");
      if (stream === "stdout" && line.trim().startsWith("{")) {
        try {
          const event: unknown = JSON.parse(line);
          if (event && typeof event === "object" && !Array.isArray(event)) {
            const record = event as Record<string, unknown>;
            if (isRollbackEvent(record)) rolledBack = true;
            if (record.event === "check") {
              if (typeof record.target_version === "string") check.target = record.target_version;
              if (typeof record.current_version === "string") check.current = record.current_version;
              else if (record.current_version === null) check.current = null;
              if (typeof record.up_to_date === "boolean") check.upToDate = record.up_to_date;
            }
            const message = typeof record.message === "string" ? record.message : "";
            if (message.includes("未找到自动重启入口") || message.includes("跳过重启")) {
              restarted = false;
            }
          }
        } catch {
          // 非 JSON 行不影响回滚判断。
        }
      }
    },
  });

  if (result.error || result.code !== 0) {
    const detail = result.error
      ? result.error
      : result.code === null
        ? `信号 ${result.signal ?? "unknown"}`
        : `退出码 ${result.code}`;
    if (rolledBack) {
      throw new CliError(
        "UPDATE_ROLLED_BACK",
        EXIT.FAIL,
        `更新失败（${detail}），已回滚到上一版本`,
      );
    }
    throw new CliError("UPDATE_FAILED", EXIT.FAIL, `更新失败（${detail}）`);
  }

  return {
    action,
    version: action === "apply" ? (options.version ?? null) : (check.target ?? null),
    ...(action === "check"
      ? {
          current_version: check.current ?? null,
          ...(check.upToDate === undefined ? {} : { up_to_date: check.upToDate }),
        }
      : {}),
    restarted,
  };
}
