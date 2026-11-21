# setup(ctx)：插件自管后端

`setup` 是插件入口的第三个可选命名导出（前两个是 `fetch` / `engine`）。它在 CLI
安装/更新/卸载插件时由独立 Node 子进程调用，**不在网关启动时执行**。

```ts
export async function setup(ctx: SetupContext) {
  // ...
}
```

`setup` 只在 manifest 声明了 `backends`（`api_version: 2`）时有实际意义；没有后端时
不需要导出。声明了 `backends` 但没导出 `setup`，自动 setup 会失败。

## action

| action | 触发 |
| --- | --- |
| `install` | `asg extensions install`（默认）、`asg extensions setup <id>` |
| `status` | `asg extensions setup <id> --status` |
| `uninstall` | `asg extensions setup <id> --uninstall`、`asg extensions remove <id>`（默认） |
| `update` | 契约预留；当前 CLI 升级插件时传 `install` |

插件不能假设 action 只出现一次。推荐：

- `install` / `update`：检查已安装版本，满足则直接返回；否则下载、校验、解压、
  原子替换，并写 `backendState`。
- `status`：只读，不下载、不改配置；返回可读状态。
- `uninstall`：只删 `backendDir(id)` 下自己安装的内容，不要删整个
  `data/extension-data/<id>`，也不要动 `data/backends`。

## ctx 概览

```ts
interface SetupContext {
  readonly action: "install" | "update" | "uninstall" | "status";
  readonly backends: string[]; // 本次选中的 backend id
  readonly plugin: { id: string; name: string; version: string };
  readonly host: { os: "linux" | "darwin" | "win32"; arch: string };
  readonly paths: SetupPaths;

  log(message: string): void;
  progress(phase: string, detail?: string): void;

  exists(target: string): Promise<boolean>;
  mkdir(target: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  remove(target: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  readFile(file: string, options?: { encoding?: "utf8" | "base64" }): Promise<string>;
  writeFile(
    file: string,
    content: string | Uint8Array,
    options?: { mode?: number; append?: boolean },
  ): Promise<void>;
  sha256(file: string): Promise<string>;
  extract(
    archive: string,
    dest: string,
    options?: { stripComponents?: number },
  ): Promise<void>;

  download(
    url: string,
    dest: string,
    options?: { sha256?: string; headers?: Record<string, string>; label?: string },
  ): Promise<void>;
  fetchText(url: string, options?: { headers?: Record<string, string>; label?: string }): Promise<string>;
  fetchJson<T = unknown>(
    url: string,
    options?: { headers?: Record<string, string>; label?: string },
  ): Promise<T>;

  run(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeoutMs?: number;
      shell?: boolean;
    },
  ): Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  }>;

  readonly config: {
    get(): Promise<Record<string, unknown>>;
    patch(value: Record<string, unknown>): Promise<Record<string, unknown>>;
    replace(value: Record<string, unknown>): Promise<Record<string, unknown>>;
    unset(paths: string[]): Promise<Record<string, unknown>>;
  };
  readonly state: {
    read(): Promise<unknown>;
    write(value: unknown): Promise<void>;
  };
  readonly backendState: {
    read(id: string): Promise<unknown>;
    write(id: string, state: unknown): Promise<void>;
    clear(id: string): Promise<void>;
  };
}
```

`host` 只有 `os` / `arch`，没有 `isWindows`；平台判断用 `ctx.host.os`。

## 路径

| 字段 | 值 | 可写 |
| --- | --- | --- |
| `paths.root` | 安装根 | — |
| `paths.pluginDir` | `data/extensions/<id>` | 否 |
| `paths.dataDir` | `data/extension-data/<id>` | 是 |
| `paths.backendDir(id)` | `data/extension-data/<id>/backends/<id>` | 是 |
| `paths.tempDir` | `data/extension-data/<id>/tmp` | 是 |
| `paths.legacyBackendDir(id)` | `data/backends/<旧目录名>` | 否（只读） |
| `paths.config` | `<root>/gateway.yaml` | 仅 config API |
| `paths.secrets` | `<root>/secrets.yaml` | 无写接口 |

相对路径按 `paths.dataDir` 解析。写操作只能落在 `dataDir` / `tempDir`，并会检查真实
路径（符号链接逃逸会被拒绝）；`rename` 的源也必须是可写路径。`pluginDir` 与旧后端目录
只能读。

运行时用 `ctx.pluginBackends.dir(id)` 取同一后端目录，`state(id)` 读安装状态；
不需要自己拼 `data/extension-data` 路径。

`legacyBackendDir(id)` 的旧目录名可以由宿主映射；当前 CLI 调用不提供映射，通常按
`backend.id` 解析。不要假设它一定等于 `backend.id`，直接用这个函数取路径。

## 文件、网络与进程

- `readFile` 默认 `utf8`；二进制用 `base64`。`writeFile` 支持 `Uint8Array`、`mode`、
  `append`，会自动建父目录。
- `mkdir` 默认递归；`remove` 默认 `recursive: true, force: true`。
- `sha256` 返回小写十六进制。
- `download` / `fetchText` / `fetchJson` 只接受 **https**。`download` 的 `sha256` 不匹配时
  会删除目标文件并报错；`fetchText` / `fetchJson` 内部先写临时文件再读。
- `extract` 支持 `.tar.gz` / `.tgz` / `.zip`；`stripComponents` 只支持 tar（zip 不支持）。
- `run` 的 `cwd` 按 `dataDir` 解析且必须存在；`env` 与 `process.env` 合并，
  `undefined` 表示删除；`timeoutMs` 默认 600000（10 分钟），`0` 不限时；
  `shell` 默认 `false`。stdout/stderr 各保留最多 4 MiB。

已有文件需要单独校验时：

```ts
const digest = await ctx.sha256(archive);
if (digest !== expectedSha256.toLowerCase()) {
  throw new Error(`SHA256 校验失败：期望 ${expectedSha256}，实际 ${digest}`);
}
```

`ctx.download` 的 `sha256` 选项已经包含“下载 + 校验 + 失败删除”的流程，优先使用它；
`ctx.sha256` 用于校验本地已有文件或自行分步下载的场景。

## config

只写 `gateway.yaml → extensions.<plugin.id>.config`：

```ts
const config = await ctx.config.get();          // 缺省 {}
await ctx.config.patch({ enabled: true });      // 递归合并
await ctx.config.replace({ enabled: true });    // 整体替换
await ctx.config.unset(["retry.times"]);        // 点号路径
```

- 每次写入前按 manifest `config_schema` 校验；失败抛错且**不落盘**。
- 注释尽量保留，写入是原子的；不会改其他插件或顶层配置。
- `gateway.yaml` 不存在时 `config` 操作会报错。
- 没有 `config_schema` 时只要求值是对象。
- 不能通过 config 写密钥。

## state / backendState

```ts
await ctx.state.write({ last_version: "1.2.3" });  // data/extension-data/<id>/state.json
const state = await ctx.state.read();              // 缺失返回 null

await ctx.backendState.write("example-cli", {
  installed: true,
  enabled: true,
  version: "1.2.3",
  path: target,
});
const one = await ctx.backendState.read("example-cli");
await ctx.backendState.clear("example-cli");
```

`backendState` 存在 `data/extension-data/<id>/backends.json`，按 backend id 索引。
`asg extensions list` 与 `asg plugins list` 只读该文件，按
`installed` / `enabled` / `version` / `path` 展示；建议写入这些字段。值必须可 JSON
序列化，`undefined` 会被拒绝。

## 幂等与旧目录迁移

必须假设 setup 会反复执行：

- 已安装且版本满足时直接返回，不重复下载；
- 下载到 `tempDir`，校验后 `rename` 到最终位置；失败不要留下半成品；
- `uninstall` 只删自己安装的内容；
- 旧 `data/backends/<name>` 只读：复制到新目录，不移动、不改写、不删除；
- 重复执行时“目标已存在”应视为成功，或按版本决定升级。

中性最小示例（`example-plugin`，后端 `example-cli`）：

```ts
import path from "node:path";

export async function setup(ctx) {
  const id = "example-cli";
  const target = ctx.paths.backendDir(id);
  const executable = path.join(target, "example-cli");
  const legacy = ctx.paths.legacyBackendDir(id);

  if (ctx.action === "status") {
    return { installed: await ctx.exists(executable), path: target };
  }

  if (ctx.action === "uninstall") {
    await ctx.remove(target, { recursive: true, force: true });
    await ctx.backendState.clear(id);
    return { removed: true };
  }

  if (await ctx.exists(executable)) {
    ctx.log("example-cli 已存在，跳过安装");
    return { installed: true, reused: true };
  }

  await ctx.mkdir(target, { recursive: true });

  // 0.3.x 旧目录：只复制，不移动、不删除。
  if (await ctx.exists(legacy)) {
    await ctx.copy(legacy, target);
  }

  if (!(await ctx.exists(executable))) {
    const archive = path.join(ctx.paths.tempDir, "example-cli.tar.gz");
    await ctx.download("https://example.com/releases/example-cli.tar.gz", archive, {
      sha256: "<64 位十六进制 sha256>",
      label: "example-cli",
    });
    await ctx.extract(archive, target, { stripComponents: 1 });
    await ctx.remove(archive, { force: true });
  }

  const version = await ctx.run(executable, ["--version"], { cwd: target });
  if (version.code !== 0) {
    throw new Error(`example-cli 校验失败：${version.stderr || version.stdout}`);
  }

  await ctx.backendState.write(id, {
    installed: true,
    enabled: true,
    version: version.stdout.trim(),
    path: target,
  });
  return { installed: true, version: version.stdout.trim() };
}
```

示例里的 URL 与 sha256 是占位；真实插件必须使用自己发布的 https 资产和真实校验值。

## 错误、超时与边界

- 抛出的错误会让 CLI 返回 `PLUGIN_FAILED`；`asg extensions install` 会保留已安装插件，
  并提示用 `asg extensions setup <id>` 重试。
- 整次 setup 默认超时 10 分钟；超时或完成后子进程会被杀掉。较长的下载/编译请拆小，
  并给 `ctx.run` 设置合适的 `timeoutMs`。
- 返回值会经过 `JSON.stringify`：`undefined` 转成 `null`，函数属性被丢弃；循环引用、
  BigInt 等无法序列化的值会报错。
- **不是安全沙箱**：setup 以用户权限运行，可执行任意命令。宿主只限制通过 `ctx` 的写入
  路径；只安装可信插件。
- 不要 import 网关内部模块，也不要依赖宿主 `node_modules`；需要第三方库时 bundle 进入口。
