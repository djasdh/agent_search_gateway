/** setup worker：独立子进程入口。
 *
 * 职责很小：
 * 1. 接收父进程的 `init`；
 * 2. dynamic import 插件入口，取 `setup` 导出；
 * 3. 构造只通过 IPC 访问父进程能力的 `ctx`；
 * 4. 调用 `setup(ctx)`，把结果/异常通过 `done` 发回。
 *
 * worker **不 import 网关内部模块**，因此插件代码也拿不到网关运行时。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isParentToWorkerMessage,
  SETUP_PROTOCOL_VERSION,
  type ParentToWorkerMessage,
  type SetupErrorInfo,
  type SetupInit,
  type SetupRpcCall,
  type SetupRpcMethod,
  type SetupRpcMethodMap,
  type SetupRpcReply,
  type WorkerToParentMessage,
} from "./protocol.js";
import {
  SETUP_ACTIONS,
  type SetupAction,
  type SetupBackendStateApi,
  type SetupConfigApi,
  type SetupContext,
  type SetupFetchOptions,
  type SetupFileContent,
  type SetupPaths,
  type SetupStateApi,
} from "./types.js";

const BACKEND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const pending = new Map<number, PendingCall>();
let nextCallId = 1;
let started = false;
let finished = false;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toErrorInfo(error: unknown): SetupErrorInfo {
  if (error instanceof Error) {
    const stack = error.stack
      ?.split("\n")
      .slice(0, 12)
      .join("\n");
    return { message: error.message || error.name, ...(stack ? { stack } : {}) };
  }
  return { message: String(error) };
}

type SendChannel = (
  message: WorkerToParentMessage,
  callback?: (error: Error | null) => void,
) => boolean;

function send(message: WorkerToParentMessage, callback?: (error: Error | null) => void): void {
  const channel = process.send as unknown as SendChannel | undefined;
  if (!channel) return;
  try {
    // process.send 依赖 this；解构后必须显式 call，否则会抛错并被 catch 吞掉。
    channel.call(process, message, callback);
  } catch (error) {
    callback?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function log(message: string): void {
  send({ type: "log", message: String(message) });
}

function progress(phase: string, detail?: string): void {
  send({
    type: "progress",
    phase: String(phase),
    ...(detail === undefined ? {} : { detail: String(detail) }),
  });
}

function rpc<K extends SetupRpcMethod>(
  method: K,
  args: SetupRpcMethodMap[K]["params"],
): Promise<SetupRpcMethodMap[K]["result"]> {
  const id = nextCallId;
  nextCallId += 1;

  // JSON 序列化会把尾部的 undefined 变成 null；发送前去掉，宿主就只会看到
  // “参数确实不存在”，而不是一个伪装的 null 选项。
  const payload = [...args];
  while (payload.length > 0 && payload[payload.length - 1] === undefined) payload.pop();

  return new Promise<SetupRpcMethodMap[K]["result"]>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as SetupRpcMethodMap[K]["result"]),
      reject,
    });

    const message = {
      type: "call",
      id,
      method,
      args: payload,
    } as SetupRpcCall;
    send(message, (error) => {
      if (!error) return;
      pending.delete(id);
      reject(new Error(`与父进程通信失败（${method}）：${error.message}`));
    });
  });
}

function assertBackendId(value: unknown, label: string): string {
  if (typeof value !== "string" || !BACKEND_ID_RE.test(value)) {
    throw new Error(
      `${label} 的后端 id 不合法：${String(value)}（只允许字母/数字/._-，首字符必须是字母或数字）`,
    );
  }
  return value;
}

function buildPaths(init: SetupInit): SetupPaths {
  const raw = init.paths;
  return {
    root: raw.root,
    pluginDir: raw.pluginDir,
    dataDir: raw.dataDir,
    tempDir: raw.tempDir,
    config: raw.config,
    secrets: raw.secrets,
    backendDir(id: string): string {
      return path.join(raw.backendDirBase, assertBackendId(id, "paths.backendDir"));
    },
  };
}

function makeConfigApi(): SetupConfigApi {
  return {
    get: () => rpc("config.get", []),
    patch: (value) => rpc("config.patch", [value]),
    replace: (value) => rpc("config.replace", [value]),
    unset: (paths) => rpc("config.unset", [paths]),
  };
}

function makeStateApi(): SetupStateApi {
  return {
    read: () => rpc("state.read", []),
    write: (value) => rpc("state.write", [value]),
  };
}

function makeBackendStateApi(): SetupBackendStateApi {
  return {
    read: (id) => rpc("backendState.read", [assertBackendId(id, "backendState.read")]),
    write: (id, state) =>
      rpc("backendState.write", [assertBackendId(id, "backendState.write"), state]),
    clear: (id) => rpc("backendState.clear", [assertBackendId(id, "backendState.clear")]),
  };
}

function buildContext(init: SetupInit): SetupContext {
  const action = init.action as SetupAction;
  const plugin = Object.freeze({ ...init.plugin });
  const host = Object.freeze({ ...init.host });
  const backends = [...init.backends];

  return {
    action,
    backends,
    plugin,
    host,
    paths: buildPaths(init),

    log,
    progress,

    exists: (target) => rpc("fs.exists", [target]),
    mkdir: (target, options) => rpc("fs.mkdir", [target, options]),
    remove: (target, options) => rpc("fs.remove", [target, options]),
    rename: (from, to) => rpc("fs.rename", [from, to]),
    copy: (from, to) => rpc("fs.copy", [from, to]),
    readFile: (file, options) => rpc("fs.readFile", [file, options]),
    writeFile: (file, content: SetupFileContent, options) =>
      rpc("fs.writeFile", [file, content, options]),
    sha256: (file) => rpc("fs.sha256", [file]),
    extract: (archive, dest, options) => rpc("fs.extract", [archive, dest, options]),

    download: (url, dest, options) => rpc("net.download", [url, dest, options]),
    fetchText: (url, options) => rpc("net.fetchText", [url, options]),
    fetchJson: <T = unknown>(url: string, options?: SetupFetchOptions) =>
      rpc("net.fetchJson", [url, options]) as Promise<T>,

    run: (command, args, options) => rpc("proc.run", [command, args, options]),

    config: makeConfigApi(),
    state: makeStateApi(),
    backendState: makeBackendStateApi(),
  };
}

/** 结果只保留 JSON 可表达的部分，避免函数/循环引用导致 IPC 序列化失败。 */
function serializableResult(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : (JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error(`setup 返回值无法序列化为 JSON：${messageOf(error)}`);
  }
}

function validateInit(init: unknown): SetupInit {
  if (typeof init !== "object" || init === null) {
    throw new Error("setup worker 收到的 init 不是对象");
  }
  const raw = init as Record<string, unknown>;
  if (raw.protocolVersion !== SETUP_PROTOCOL_VERSION) {
    throw new Error(
      `setup 协议版本不匹配：worker 期望 ${SETUP_PROTOCOL_VERSION}，收到 ${String(raw.protocolVersion)}`,
    );
  }
  if (typeof raw.entry !== "string" || raw.entry.length === 0) {
    throw new Error("setup init 缺少 entry");
  }
  if (!SETUP_ACTIONS.includes(raw.action as SetupAction)) {
    throw new Error(`setup init 的 action 不合法：${String(raw.action)}`);
  }
  if (!Array.isArray(raw.backends) || raw.backends.some((item) => typeof item !== "string")) {
    throw new Error("setup init 的 backends 必须是字符串数组");
  }

  if (typeof raw.plugin !== "object" || raw.plugin === null) {
    throw new Error("setup init 缺少 plugin 信息");
  }
  const plugin = raw.plugin as Record<string, unknown>;
  for (const key of ["id", "name", "version"] as const) {
    if (typeof plugin[key] !== "string" || plugin[key].length === 0) {
      throw new Error(`setup init 的 plugin.${key} 必须是非空字符串`);
    }
  }

  if (typeof raw.host !== "object" || raw.host === null) {
    throw new Error("setup init 缺少 host 信息");
  }
  const host = raw.host as Record<string, unknown>;
  if (host.os !== "linux" && host.os !== "darwin" && host.os !== "win32") {
    throw new Error(`setup init 的 host.os 不合法：${String(host.os)}`);
  }
  if (typeof host.arch !== "string" || host.arch.length === 0) {
    throw new Error("setup init 的 host.arch 必须是非空字符串");
  }

  if (typeof raw.paths !== "object" || raw.paths === null) {
    throw new Error("setup init 缺少 paths");
  }
  const paths = raw.paths as Record<string, unknown>;
  for (const key of [
    "root",
    "pluginDir",
    "dataDir",
    "tempDir",
    "config",
    "secrets",
    "backendDirBase",
  ] as const) {
    if (typeof paths[key] !== "string" || paths[key].length === 0) {
      throw new Error(`setup init 的 paths.${key} 必须是非空字符串`);
    }
  }

  return raw as unknown as SetupInit;
}

async function runSetup(init: SetupInit): Promise<unknown> {
  const context = buildContext(init);

  let module: unknown;
  try {
    module = await import(pathToFileURL(init.entry).href);
  } catch (error) {
    throw new Error(`无法加载插件入口：${init.entry}：${messageOf(error)}`);
  }

  const setup =
    typeof module === "object" && module !== null
      ? (module as Record<string, unknown>).setup
      : undefined;
  if (typeof setup !== "function") {
    throw new Error(`插件 ${init.plugin.id} 的入口 ${init.entry} 没有导出 setup 函数`);
  }

  const result = await (setup as (ctx: SetupContext) => unknown)(context);
  return serializableResult(result);
}

function finish(result: unknown, error: SetupErrorInfo | undefined): void {
  if (finished) return;
  finished = true;
  const message: WorkerToParentMessage = {
    type: "done",
    ...(error ? { error } : { result }),
  };
  send(message, () => {
    // 无论成功失败都主动退出，避免插件留下的 timer/handle 让子进程悬挂。
    process.exit(0);
  });
}

function handleInit(initValue: unknown): void {
  if (started) {
    log("setup worker 已启动，忽略重复的 init");
    return;
  }
  started = true;

  let init: SetupInit;
  try {
    init = validateInit(initValue);
  } catch (error) {
    finish(undefined, toErrorInfo(error));
    return;
  }

  void runSetup(init).then(
    (result) => finish(result, undefined),
    (error: unknown) => finish(undefined, toErrorInfo(error)),
  );
}

function handleReply(message: SetupRpcReply): void {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);

  if (message.ok) {
    entry.resolve(message.result);
    return;
  }

  const error = new Error(message.error.message);
  if (message.error.stack) error.stack = message.error.stack;
  entry.reject(error);
}

function handleMessage(value: unknown): void {
  if (!isParentToWorkerMessage(value)) {
    log("setup worker 收到无法识别的消息，已忽略");
    return;
  }
  const message = value as ParentToWorkerMessage;
  if (message.type === "init") {
    handleInit(message.init);
    return;
  }
  handleReply(message);
}

if (!process.send) {
  process.stderr.write("setup worker 必须通过 IPC 启动（缺少 process.send）\n");
  process.exit(1);
}

process.on("message", handleMessage);
process.on("uncaughtException", (error) => {
  // 插件里的 fire-and-forget 异常也通过 done 回传，避免只剩通用 exit 错误。
  finish(undefined, toErrorInfo(error));
});
process.on("unhandledRejection", (reason) => {
  finish(undefined, toErrorInfo(reason));
});
process.on("disconnect", () => {
  // 父进程消失后没有可回复的对象，直接退出，避免孤儿进程。
  process.exit(0);
});
