/** CLI 子进程流式工具：逐行转发 stdout/stderr，供 browser / update 等命令共用。 */

import { spawn } from "node:child_process";
import process from "node:process";
import type { Reporter } from "../output.js";

export interface StreamResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export type StreamKind = "stdout" | "stderr";

export interface StreamOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string, stream: StreamKind) => void;
}

/** 注入点：默认用 spawn 流式读取，测试可换成记录参数并回放事件的假实现。 */
export type StreamRunner = (
  command: string,
  args: string[],
  options?: StreamOptions,
) => Promise<StreamResult>;

/** 流式子进程：逐行回调 stdout/stderr，不做 shell 解析。 */
export const spawnStream: StreamRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, error: messageOf(error) });
      return;
    }

    const buffers: Record<StreamKind, string> = { stdout: "", stderr: "" };
    const feed = (kind: StreamKind, chunk: Buffer | string): void => {
      buffers[kind] += chunk.toString();
      let index = buffers[kind].indexOf("\n");
      while (index !== -1) {
        const line = buffers[kind].slice(0, index).replace(/\r$/, "");
        buffers[kind] = buffers[kind].slice(index + 1);
        if (line.length > 0) options.onLine?.(line, kind);
        index = buffers[kind].indexOf("\n");
      }
    };

    let settled = false;
    const finish = (result: StreamResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => feed("stdout", chunk));
    child.stderr?.on("data", (chunk) => feed("stderr", chunk));
    child.on("error", (error) => finish({ code: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => {
      for (const kind of ["stdout", "stderr"] as const) {
        const rest = buffers[kind].replace(/\r$/, "");
        if (rest.length > 0) options.onLine?.(rest, kind);
      }
      finish({ code, signal });
    });
  });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const data: unknown = JSON.parse(trimmed);
    if (isRecord(data)) return data;
  } catch {
    // 不是合法 JSON，按普通日志处理。
  }
  return null;
}

/** 把子进程输出转发为 event：JSON 行原样透传，其它行包成 log 事件。 */
export function forwardChildLine(reporter: Reporter, line: string, service: string): void {
  if (!line.trim()) return;

  const parsed = parseEventLine(line);
  if (parsed) {
    const { type: _type, ...event } = parsed;
    if (typeof event.event !== "string") event.event = "log";
    if (typeof event.service !== "string") event.service = service;
    if (typeof event.message !== "string" && typeof event.line === "string") {
      event.message = event.line;
    }
    reporter.event(event);
    return;
  }

  reporter.event({ event: "log", service, line, message: line });
}
