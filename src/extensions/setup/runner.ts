/** 启动 setup 子进程、转发事件、处理超时与清理。 */

import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SetupHost, resolveSetupPaths, setupHostInfo } from "./host.js";
import {
  isWorkerToParentMessage,
  SETUP_PROTOCOL_VERSION,
  type SetupInit,
  type SetupRpcReply,
} from "./protocol.js";
import type { SetupAction, SetupPluginInfo } from "./types.js";

/** 默认 10 分钟；插件安装/下载通常远小于这个值。 */
const DEFAULT_TIMEOUT_MS = 600_000;
const STDERR_TAIL_BYTES = 8_000;

export interface RunPluginSetupOptions {
  root: string;
  /** 插件入口；相对路径按 pluginDir 解析，必须位于 pluginDir 内。 */
  entry: string;
  action: SetupAction;
  plugin: SetupPluginInfo;
  backends?: string[];
  /** 默认 600000ms；0 表示不限时。 */
  timeoutMs?: number;
  /** 覆盖 worker 路径（测试或定制发行版使用）。 */
  workerPath?: string;
  /** 测试注入点；默认 child_process.fork。 */
  fork?: typeof fork;
  /** manifest 的 config_schema；提供后所有 config 写入都会先校验。 */
  configSchema?: unknown;
  /** 插件 log 与宿主内部日志。 */
  onLog?: (message: string) => void;
  onProgress?: (phase: string, detail?: string) => void;
}

export interface RunPluginSetupResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(child: string, parent: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= STDERR_TAIL_BYTES ? next : next.slice(next.length - STDERR_TAIL_BYTES);
}

function forwardLines(
  stream: NodeJS.ReadableStream | null,
  prefix: string,
  onLine: (line: string) => void,
  onText: (text: string) => void,
): void {
  if (!stream) return;
  let buffer = "";
  const emit = (line: string): void => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.length > 0) onLine(`${prefix}${trimmed}`);
  };

  stream.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    onText(text);
    buffer += text;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      emit(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      const line = buffer;
      buffer = "";
      emit(line);
    }
  });
}

/**
 * 在独立子进程里执行插件 setup。
 *
 * 子进程只做崩溃隔离/超时/日志转发，**不是安全沙箱**。
 */
export async function runPluginSetup(
  options: RunPluginSetupOptions,
): Promise<RunPluginSetupResult> {
  const paths = resolveSetupPaths(options.root, options.plugin.id);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("runPluginSetup 的 timeoutMs 必须是非负整数");
  }
  if (options.backends !== undefined && !Array.isArray(options.backends)) {
    throw new Error("runPluginSetup 的 backends 必须是字符串数组");
  }
  const backends = [...(options.backends ?? [])];
  if (backends.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("runPluginSetup 的 backends 必须是非空字符串数组");
  }

  const entry = path.isAbsolute(options.entry)
    ? path.normalize(options.entry)
    : path.resolve(paths.pluginDir, options.entry);
  if (!isInside(entry, paths.pluginDir)) {
    throw new Error(`setup 入口必须位于插件目录内：${entry}（插件目录：${paths.pluginDir}）`);
  }

  const forkImpl = options.fork ?? fork;
  const workerPath =
    options.workerPath ?? fileURLToPath(new URL("./worker.js", import.meta.url));
  if (!options.fork && !fs.existsSync(workerPath)) {
    return {
      ok: false,
      error: `找不到 setup worker：${workerPath}。请先执行 npm run build 生成 dist 后再运行 setup。`,
    };
  }

  const host = new SetupHost({
    root: paths.root,
    plugin: options.plugin,
    logger: options.onLog,
    ...(options.configSchema !== undefined ? { configSchema: options.configSchema } : {}),
  });

  const init: SetupInit = {
    protocolVersion: SETUP_PROTOCOL_VERSION,
    entry,
    action: options.action,
    backends,
    plugin: { ...options.plugin },
    host: setupHostInfo(),
    paths: host.initPaths(),
  };

  return await new Promise<RunPluginSetupResult>((resolve) => {
    let settled = false;
    let stderrTail = "";
    let timer: NodeJS.Timeout | undefined;

    const child = (() => {
      try {
        return forkImpl(workerPath, [], {
          cwd: paths.root,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          serialization: "advanced",
        });
      } catch (error) {
        settled = true;
        resolve({
          ok: false,
          error: `无法启动 setup 子进程（${workerPath}）：${messageOf(error)}`,
        });
        return null;
      }
    })();
    if (!child) return;

    const killChild = (): void => {
      if (child.killed) return;
      try {
        // setup 已经结束（done / 超时 / 父进程退出），直接强杀，避免残留孤儿进程。
        child.kill("SIGKILL");
      } catch {
        // 进程可能已经退出
      }
    };

    const onProcessExit = (): void => {
      host.dispose();
      killChild();
    };
    const onSigint = (): void => {
      host.dispose();
      killChild();
      unregister();
      process.kill(process.pid, "SIGINT");
    };
    const onSigterm = (): void => {
      host.dispose();
      killChild();
      unregister();
      process.kill(process.pid, "SIGTERM");
    };
    const unregister = (): void => {
      process.removeListener("exit", onProcessExit);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };

    process.once("exit", onProcessExit);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    const finish = (result: RunPluginSetupResult, kill: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unregister();
      child.removeAllListeners("message");
      child.removeAllListeners("exit");
      // 保留 error 监听：子进程退出阶段仍可能 emit error，移除会导致未捕获异常。
      host.dispose();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (kill) killChild();
      resolve(result);
    };

    const sendReply = (reply: SetupRpcReply): void => {
      try {
        child.send(reply);
      } catch {
        // 子进程已退出；done/exit 逻辑会给出最终错误
      }
    };

    child.on("message", (raw: unknown) => {
      if (!isWorkerToParentMessage(raw)) {
        options.onLog?.("[setup] 忽略无法识别的子进程消息");
        return;
      }

      switch (raw.type) {
        case "log":
          options.onLog?.(raw.message);
          return;
        case "progress":
          options.onProgress?.(raw.phase, raw.detail);
          return;
        case "done": {
          if (raw.error) {
            const stack = raw.error.stack ? `\n${raw.error.stack}` : "";
            finish({ ok: false, error: `${raw.error.message}${stack}` }, true);
          } else {
            finish({ ok: true, result: raw.result }, true);
          }
          return;
        }
        case "call": {
          void host.dispatch(raw.method, raw.args).then(
            (result) => {
              sendReply({ type: "reply", id: raw.id, ok: true, result });
            },
            (error: unknown) => {
              sendReply({
                type: "reply",
                id: raw.id,
                ok: false,
                error: {
                  message: messageOf(error),
                  ...(error instanceof Error && error.stack
                    ? { stack: error.stack.split("\n").slice(0, 12).join("\n") }
                    : {}),
                },
              });
            },
          );
          return;
        }
      }
    });

    forwardLines(
      child.stdout,
      "[setup stdout] ",
      (line) => options.onLog?.(line),
      (text) => {
        stderrTail = appendTail(stderrTail, text);
      },
    );
    forwardLines(
      child.stderr,
      "[setup stderr] ",
      (line) => options.onLog?.(line),
      (text) => {
        stderrTail = appendTail(stderrTail, text);
      },
    );

    child.once("error", (error) => {
      finish(
        {
          ok: false,
          error: `setup 子进程启动/运行失败：${messageOf(error)}`,
        },
        true,
      );
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      const detail = stderrTail.trim();
      finish(
        {
          ok: false,
          error: `setup 子进程在返回结果前退出（code=${String(code)}, signal=${String(signal)}）${
            detail ? `\n${detail}` : ""
          }`,
        },
        false,
      );
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        finish(
          {
            ok: false,
            error: `插件 ${options.plugin.id} 的 setup 在 ${timeoutMs}ms 内未完成（action=${options.action}）`,
          },
          true,
        );
      }, timeoutMs);
    }

    try {
      child.send({ type: "init", init }, (error: Error | null) => {
        if (!error) return;
        finish(
          {
            ok: false,
            error: `无法向 setup 子进程发送 init：${messageOf(error)}`,
          },
          true,
        );
      });
    } catch (error) {
      finish(
        {
          ok: false,
          error: `无法向 setup 子进程发送 init：${messageOf(error)}`,
        },
        true,
      );
    }
  });
}
