/** 父进程 ↔ setup worker 的 IPC 消息协议。
 *
 * 只有两种方向：
 * - parent → worker：`init` 初始化一次，之后是对每次 `call` 的 `reply`；
 * - worker → parent：`log` / `progress` / `call` / `done`。
 *
 * 消息必须是结构化可克隆的纯数据（不传函数、不传 Error 实例），
 * 这样 `serialization: "advanced"` 与 JSON 两种模式都能稳定工作。
 */

import type {
  SetupAction,
  SetupDownloadOptions,
  SetupExtractOptions,
  SetupFetchOptions,
  SetupFileContent,
  SetupHostInfo,
  SetupMkdirOptions,
  SetupPluginInfo,
  SetupReadFileOptions,
  SetupRemoveOptions,
  SetupRunOptions,
  SetupRunResult,
  SetupWriteFileOptions,
} from "./types.js";

export const SETUP_PROTOCOL_VERSION = 1 as const;

/** worker 侧计算路径所需的原始路径数据（函数无法跨 IPC）。 */
export interface SetupInitPaths {
  root: string;
  pluginDir: string;
  dataDir: string;
  tempDir: string;
  config: string;
  secrets: string;
  /** `backendDir(id)` 的父目录，通常是 `<dataDir>/backends`。 */
  backendDirBase: string;
}

export interface SetupInit {
  protocolVersion: typeof SETUP_PROTOCOL_VERSION;
  /** 插件入口的绝对路径，必须位于 pluginDir 内。 */
  entry: string;
  action: SetupAction;
  backends: string[];
  plugin: SetupPluginInfo;
  host: SetupHostInfo;
  paths: SetupInitPaths;
}

/** 每个 RPC 方法的参数元组与返回值类型。 */
export interface SetupRpcMethodMap {
  "fs.exists": { params: [target: string]; result: boolean };
  "fs.mkdir": { params: [target: string, options?: SetupMkdirOptions]; result: void };
  "fs.remove": { params: [target: string, options?: SetupRemoveOptions]; result: void };
  "fs.rename": { params: [from: string, to: string]; result: void };
  "fs.copy": { params: [from: string, to: string]; result: void };
  "fs.readFile": {
    params: [file: string, options?: SetupReadFileOptions];
    result: string;
  };
  "fs.writeFile": {
    params: [file: string, content: SetupFileContent, options?: SetupWriteFileOptions];
    result: void;
  };
  "fs.sha256": { params: [file: string]; result: string };
  "fs.extract": {
    params: [archive: string, dest: string, options?: SetupExtractOptions];
    result: void;
  };
  "net.download": {
    params: [url: string, dest: string, options?: SetupDownloadOptions];
    result: void;
  };
  "net.fetchText": {
    params: [url: string, options?: SetupFetchOptions];
    result: string;
  };
  "net.fetchJson": {
    params: [url: string, options?: SetupFetchOptions];
    result: unknown;
  };
  "proc.run": {
    params: [command: string, args?: readonly string[], options?: SetupRunOptions];
    result: SetupRunResult;
  };
  "config.get": { params: []; result: Record<string, unknown> };
  "config.patch": {
    params: [value: Record<string, unknown>];
    result: Record<string, unknown>;
  };
  "config.replace": {
    params: [value: Record<string, unknown>];
    result: Record<string, unknown>;
  };
  "config.unset": { params: [paths: string[]]; result: Record<string, unknown> };
  "state.read": { params: []; result: unknown };
  "state.write": { params: [value: unknown]; result: void };
  "backendState.read": { params: [id: string]; result: unknown };
  "backendState.write": { params: [id: string, state: unknown]; result: void };
  "backendState.clear": { params: [id: string]; result: void };
}

export type SetupRpcMethod = keyof SetupRpcMethodMap;

/** worker → parent 的 RPC 调用。 */
export type SetupRpcCall = {
  [K in SetupRpcMethod]: {
    type: "call";
    id: number;
    method: K;
    args: SetupRpcMethodMap[K]["params"];
  };
}[SetupRpcMethod];

export interface SetupErrorInfo {
  message: string;
  /** 最多保留一段 stack 摘要，避免 IPC 消息过大。 */
  stack?: string;
}

export type SetupRpcReply =
  | { type: "reply"; id: number; ok: true; result?: unknown }
  | { type: "reply"; id: number; ok: false; error: SetupErrorInfo };

export type ParentToWorkerMessage =
  | { type: "init"; init: SetupInit }
  | SetupRpcReply;

export type WorkerToParentMessage =
  | SetupRpcCall
  | { type: "log"; message: string }
  | { type: "progress"; phase: string; detail?: string }
  | { type: "done"; result?: unknown; error?: SetupErrorInfo };

const RPC_METHODS = new Set<string>([
  "fs.exists",
  "fs.mkdir",
  "fs.remove",
  "fs.rename",
  "fs.copy",
  "fs.readFile",
  "fs.writeFile",
  "fs.sha256",
  "fs.extract",
  "net.download",
  "net.fetchText",
  "net.fetchJson",
  "proc.run",
  "config.get",
  "config.patch",
  "config.replace",
  "config.unset",
  "state.read",
  "state.write",
  "backendState.read",
  "backendState.write",
  "backendState.clear",
]);

export function isSetupRpcMethod(value: unknown): value is SetupRpcMethod {
  return typeof value === "string" && RPC_METHODS.has(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** runner 收到未知消息时用它过滤；只做结构最小校验，真正的参数校验在 host。 */
export function isWorkerToParentMessage(value: unknown): value is WorkerToParentMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "log":
      return typeof value.message === "string";
    case "progress":
      return typeof value.phase === "string";
    case "done":
      return true;
    case "call":
      return (
        typeof value.id === "number" &&
        Number.isInteger(value.id) &&
        isSetupRpcMethod(value.method) &&
        Array.isArray(value.args)
      );
    default:
      return false;
  }
}

/** worker 收到父进程消息时用它做最小校验。 */
export function isParentToWorkerMessage(value: unknown): value is ParentToWorkerMessage {
  if (!isRecord(value)) return false;
  if (value.type === "init") return isRecord(value.init);
  if (value.type === "reply") return typeof value.id === "number" && typeof value.ok === "boolean";
  return false;
}
