# 第三方扩展：声明、安装与后端 setup

本文说明第三方插件（extension）的 manifest、`setup` 钩子、安装/数据目录与
`asg extensions` 命令。

> **0.4.0 起只接受 V2 manifest（`asg-extension.json`，`api_version: 2`）。**
> V1 manifest（`asg-plugin.json`）与 V1 运行期加载已移除；旧插件需先按
> [`../skills/asg-plugin-authoring/v2skills.md`](../skills/asg-plugin-authoring/v2skills.md)
> 迁移。0.3.x 的 V1 说明只保留在
> [`../skills/asg-plugin-authoring/legacy/`](../skills/asg-plugin-authoring/legacy/)。
>
> V2 的 `fetch_channels` 用于派生 fetch platform，`search_engines` 用于补搜索源展示名；
> 声明了 `backends` 时，插件运行时可以通过 `ctx.pluginBackends` 拿到自己安装的后端
> 目录与状态。官方插件版本：bilibili / cnki `0.2.0`，weibo `0.2.2`。
>
> 安装、setup、卸载都不会自动重启网关；`config` / `secret` 仍会整栈重启。

## 1. 目录布局

| 路径 | 用途 | 插件可写 |
| --- | --- | --- |
| `<root>/data/extensions/<id>/` | 已安装插件目录：`asg-extension.json`（V2）、入口与插件自带只读资源 | 否 |
| `<root>/data/extension-data/<id>/` | 插件数据目录：`state.json`、`backends.json`、`backends/<backend-id>/`、`tmp/` | 是 |
| `<root>/data/backends/<name>/` | 0.3.x 旧后端目录；0.4.1 起不再读取，可自行清理 | 否 |
| `<root>/gateway.yaml` | 网关配置；`extensions.<id>.config` 由 CLI 或 setup 配置 API 写入 | 仅 config API |
| `<root>/secrets.yaml` | 密钥；由 `asg extensions secret` 写入 | setup 无写接口 |

- 安装根目录是 `data/extensions/<id>/`，**目录存在即视为已安装**；目录名必须等于
  manifest 的 `id`，没有额外注册表或数据库。
- 安装过程中会短暂出现 `.staging-*` 与 `.trash-*` 目录；命令结束后会清理。
  插件更新是“替换整个 `data/extensions/<id>`”，因此**可写数据必须放在
  `data/extension-data/<id>`**，否则更新会丢数据。
- `data/extension-data/<id>` 与插件安装目录分离：更新/重装插件不会删除它；
  `asg extensions remove <id>` 默认会删除它，`--keep-data` 保留。
- `data/backends` 是 0.3.x 旧安装器的目录；**0.4.1 起 CLI、setup 宿主与运行时都不再读取**。
  需要保留的数据请自行复制到 `data/extension-data/<id>/backends/<backend-id>`；CLI 不会
  删除旧目录。
- `asg extensions list` 遇到损坏的安装目录时只把该条标记为错误（JSON 里有 `error`
  字段），不会让整条命令失败；`backends.json` 损坏只告警并按“未安装”展示。

`bilibili`、`weibo`、`cnki` 是官方插件 id：核心不再内置对应实现，需通过
`asg extensions install` 安装官方插件仓库；安装后由扩展机制加载。它们与其他插件一样
使用本文的 manifest、setup 与数据布局。0.4.0 配套版本：bilibili / cnki `0.2.0`，
weibo `0.2.2`。

## 2. manifest

文件发现：

```text
0.4.0+: 只接受 asg-extension.json（api_version: 2）
0.3.x: 优先 asg-extension.json，缺失时回退 asg-plugin.json
```

安装 Release 时同样只按这个规则选择资产。**`asg-plugin.json` 在 0.4.0 起不再加载。**

| 字段 | 版本 | 必填 | 规则 |
| --- | --- | --- | --- |
| `id` | V2 | 是 | 3–64 位小写字母/数字/`.` `_` `-`，首尾必须是字母或数字；安装目录名必须与它一致 |
| `name` | V2 | 是 | 显示名 |
| `version` | V2 | 是 | 语义化版本；必须与 Release tag 去掉 `v` 后一致 |
| `api_version` | V2 | 是 | 固定为 `2` |
| `provides` | V2 | 是 | 元素只能是 `"search"` / `"fetch"` |
| `entry` | V2 | 是 | 单个 `.mjs` / `.js` 文件名；不能含 `/`、`\`、`..`，不能是绝对路径 |
| `description` | V2 | 否 | 人类可读摘要 |
| `config_schema` | V2 | 否 | 私有配置的 JSON Schema 子集，见第 4 节 |
| `backends` | V2 | 否 | 后端声明，见 2.1 |
| `fetch_channels` | V2 | 否 | 抓取通道声明，见 2.2 |
| `search_engines` | V2 | 否 | 搜索源声明，见 2.3 |

`platform` 是 0.3.x V1 manifest 的字段，0.4.0 不再接受；V2 的 platform 从
`fetch_channels[].id` 前缀派生。

本版本仍按字段类型、必填项和路径安全约束校验；未知字段会被忽略，但不要依赖这一点。
`api_version` 不是 `2` 的 manifest 会被拒绝，不再进入运行时。

### 2.1 `backends`

`backends` 只描述后端身份，不承载代码、安装命令或版本；真正安装由入口导出的
`setup(ctx)` 决定（见第 5 节）。

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 后端 ID；用于 `data/extension-data/<id>/backends/<backend-id>` 和 `backends.json` |
| `name` | 是 | 显示名 |
| `description` | 否 | 人类可读摘要 |
| `aliases` | 否 | 旧输入名；只用于兼容历史配置/密钥键 |

### 2.2 `fetch_channels`

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | `platform:channel` |
| `name` | 否 | 显示名，缺省用 `id` |
| `description` | 否 | 人类可读摘要 |
| `backends` | 否 | 该通道拥有的后端 id；省略表示无外部后端 |
| `aliases` | 否 | 通道输入别名 |

### 2.3 `search_engines`

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | `gateway.search:<name>` 或 `gateway.reverse_image:<name>` |
| `name` | 否 | 显示名，缺省用 `id` |
| `description` | 否 | 人类可读摘要 |

### 2.4 完整示例

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "0.2.0",
  "api_version": 2,
  "description": "示例扩展",
  "provides": ["search", "fetch"],
  "entry": "index.mjs",
  "backends": [
    {
      "id": "example-cli",
      "name": "Example CLI",
      "description": "示例命令行后端",
      "aliases": ["example"]
    }
  ],
  "fetch_channels": [
    {
      "id": "example:cli",
      "name": "Example CLI",
      "description": "通过本地 CLI 抓取",
      "backends": ["example-cli"],
      "aliases": ["example"]
    }
  ],
  "search_engines": [
    {
      "id": "gateway.search:example",
      "name": "Example Search",
      "description": "示例搜索源"
    }
  ]
}
```

### 2.5 `api_version`

| 版本 | 0.4.0 行为 |
| --- | --- |
| `1` | 拒绝，不再加载；`asg-plugin.json` 也不会被发现 |
| `2` | 唯一受支持的版本；platform 从 `fetch_channels[0].id` 前缀派生；`search_engines` 补展示名；`backends` 注入 `ctx.pluginBackends` |

声明了 `backends` 的插件应在入口导出 `setup`（见第 5 节）；安装时不会检查该导出。

## 3. `provides` 的语义

| 值 | 含义 | 运行时约定 |
| --- | --- | --- |
| `search` | 提供搜索源/搜索计划 | 从 `entry` 读取命名导出 `engine` |
| `fetch` | 提供抓取实现 | 从 `entry` 读取命名导出 `fetch` |
| `["search", "fetch"]` | 同时提供两类能力 | 同一文件可同时导出 `engine` 与 `fetch` |

`provides` 同时决定运行时校验：`fetch` 必须导出带 `match` / `fetch` 函数的对象，
`search` 必须导出带 `id` / `group` / `name` / `runtime` 的对象。导出缺失或类型不符时，
该插件会被跳过并在日志中告警，不影响其它插件与内置实现。

`setup` 是**独立于 `provides` 的第三个可选导出**：只在 CLI 安装/更新/卸载插件时由
setup worker 读取，网关运行时不调用它，也不因缺少它而影响 `search` / `fetch` 加载。

## 4. 插件私有配置（`config_schema`）

插件可以在 manifest 里用可选的 `config_schema` 声明自己的配置。网关用这份 schema 校验
`gateway.yaml → extensions.<manifest id>.config`，补齐默认值，再把结果以只读对象注入
`ctx.pluginConfig`；密钥则单独走 `secrets.yaml` 与 `ctx.pluginSecrets`。

没有 `config_schema` 的旧 manifest 行为不变：`config` 原样透传（必须是对象），空对象不注入。

### 4.1 manifest 示例

```json
{
  "id": "example-fetch",
  "name": "Example Fetch Plugin",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "config_schema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true, "description": "总开关" },
      "timeout_ms": {
        "type": "integer",
        "default": 15000,
        "minimum": 1000,
        "maximum": 60000,
        "description": "单次请求超时（毫秒）"
      },
      "user_agent": { "type": "string", "description": "自定义 User-Agent；缺省用插件内置值" },
      "mode": { "type": "string", "enum": ["fast", "full"], "default": "fast", "description": "抓取模式" }
    }
  }
}
```

### 4.2 用户配置

```yaml
# gateway.yaml
extensions:
  example-fetch:            # manifest id，不是 engineId
    config:
      timeout_ms: 20000
```

- 键是 **manifest 的 `id`**（安装目录名），不是 `gateway.search:weibo` 这类 engineId。
- 默认值只在运行期补齐，不写回 `gateway.yaml`；`asg extensions config` 也只落盘用户显式设置的值。
- 读取完整配置（含默认值）：`asg extensions config example-fetch`。
- 插件也可以在 setup 里通过 `ctx.config` 读写同一段配置；规则见 5.7。

### 4.3 支持的 JSON Schema 子集

根节点必须是 `type: "object"` 且声明 `properties`（可以是空对象）。每个节点支持：

`type`、`description`、`default`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、
`items`、`properties`、`required`、`additionalProperties`。

- `type` 只能是 `object` / `string` / `number` / `integer` / `boolean` / `array`；
- `enum` 必须是非空数组，元素只能是字符串、数字或布尔值；
- 省略 `additionalProperties` 时按 `false` 处理（拒绝拼写错误与未知键）；
- 递归深度 ≤ 8（根节点算第 1 层），schema 节点总数 ≤ 256；
- 不支持 `$ref`、`pattern`、`oneOf` / `anyOf` / `allOf`、`format` 等关键字；
  出现未知关键字会直接报错，不会静默忽略；
- `default` 必须能通过该节点自己的 schema，否则 manifest 校验失败。

### 4.4 校验、默认值与失败行为

- 加载时先校验 manifest 与 `config_schema` 定义，再校验用户配置；未知键、类型错误、
  枚举越界、`required` 缺失都会让该插件**整包跳过**，只记录 error + warn，不影响其它插件与网关启动。
- 配置不合法时不会 `import` 插件入口模块。
- `asg extensions config` 写前用同一套 schema 校验；失败返回 `CONFIG_INVALID`，
  **不写文件、不重启**，目标文件保持原样。
- setup 的 `ctx.config.patch` / `replace` / `unset` 同样按 schema 校验；失败不落盘。
- 读取时补默认值；`--set` / `--unset` / `--file` 写入的始终是原始用户值，默认值不落盘。

### 4.5 运行期上下文

`search` 插件（`EngineProviderContext`）与 `fetch` 插件（`FetchProviderContext`）都会收到：

```ts
ctx.pluginConfig?: Readonly<Record<string, unknown>>; // 已补默认值并递归冻结
ctx.pluginSecrets?: Record<string, string>;           // 已解析 env:，空值不注入
ctx.pluginBackends?: PluginBackends;                  // 仅 V2 声明 backends 时注入
```

`pluginBackends` 只有 V2 manifest 声明了 `backends` 才存在：

```ts
interface PluginBackends {
  readonly ids: readonly string[];   // manifest 声明的后端 id
  dir(id: string): string;           // data/extension-data/<id>/backends/<backend-id>
  state(id: string): PluginBackendState | undefined;
}

interface PluginBackendState {
  installed: boolean;
  enabled: boolean;
  version?: string;
  path?: string;
}
```

- `dir(id)` 始终返回路径（即使还没安装）；`state(id)` 读取 `backends.json`，并结合
  后端目录是否存在判断 `installed`。
- setup 安装完后端后，运行时用同一个 id 取目录；插件不需要自己拼 `data/extension-data`
  路径。
- `pluginConfig` 来自 `extensions.<manifest id>.config`；声明了 `config_schema` 时即使
  用户没写配置也会注入补齐默认值后的对象。
- `pluginSecrets` 只读 `extensions.<manifest id>.<name>`；0.4.0 起不再兼容
  `extensions.<engineId>.<name>`。
- fetch 的 `match(url)` **不注入配置**：只能看 URL；`enabled` / `available` / `fetch` 才能读 `ctx.pluginConfig`。
- `ctx.config` / `ctx.secrets` 是核心内置实现使用的配置切片，不属于第三方扩展的
  稳定契约；第三方扩展只读 `pluginConfig` / `pluginSecrets`。0.4.0 起平台专属切片
  已从 `ctx.settings` 删除，外部插件不应再依赖它。
- `requires: ["secret:<name>"]` 只声明依赖；缺失时宿主强制 `available()` 返回 false。

### 4.6 密钥

```yaml
# secrets.yaml
extensions:
  example-fetch:
    api_key: env:EXAMPLE_API_KEY
```

- 密钥键固定为 `extensions.<manifest id>.<name>`；`extensions.<engineId>.<name>` 在
  0.4.0 起不再读取。
- `asg extensions secret <id> --name <name> --stdin` 与
  `asg engines secret <engine> --name <name> --stdin` 都写 manifest id 键；
  engineId 仅用于 `extensions.<engineId>.routing`。
- 密钥**不放** `config` / `gateway.yaml`；`config_schema` 只描述非敏感配置。
- setup 没有写密钥的 API；需要密钥的后端由用户在启动网关的环境里提供（环境变量等），
  或由插件在 setup 中提示用户执行 `asg extensions secret`。

### 4.7 字段命名规范

配置字段统一 **snake_case**，优先复用核心词汇；禁止同义混用。发布后不改字段语义。

| 语义 | 统一字段 | 类型 | 避免 |
| --- | --- | --- | --- |
| 总开关 | `enabled` | boolean | `enable`、`disabled`、`active` |
| 上游根地址 | `base_url` | string | `api_base`、`endpoint`、`host` |
| 超时 | `timeout_ms` | integer | `timeout`、`timeout_sec` |
| 单次结果上限 | `limit` | integer | `max`、`count`、`page_size` |
| 分资源上限 | `<resource>_limit` | integer | `limit_<resource>` |
| 重试次数 | `max_retries` | integer | `retry`、`retries` |
| 重试退避 | `retry_backoff_ms` | integer | `backoff`、`retry_delay` |
| 缓存时长 | `cache_ttl_ms` | integer | `ttl`、`cache_seconds` |
| 字节/字符上限 | `max_bytes` / `max_chars` | integer | `max_size`、`max_length` |
| 语言 | `languages` | string[] | `lang`、`language` |
| 类别 | `categories`；单值用 `category` | string[] / string | `category_list` |
| 模式 | `mode` + `enum` | string | `type`、`kind` |
| 文件/目录 | `*_path` / `*_dir` | string | `*_file`、`*_folder` |
| 用户代理 | `user_agent` | string | `ua` |
| 密钥 | 不放 config | — | 一律走 `pluginSecrets` |

补充规则：

- 单位写进后缀（`timeout_ms`、`cache_ttl_ms`、`max_bytes`）；
- 布尔用肯定式（`enabled`，不要 `disabled`）；
- 每个字段都写 `description`；能安全默认的写 `default`；
- 每个 object 层级显式或隐式 `additionalProperties: false`；
- 同一语义只用一个名字，避免 `timeout` / `timeout_ms` 并存。

## 5. setup 钩子：插件自管后端

插件入口可以额外导出一个 `setup` 函数：

```ts
export async function setup(ctx) {
  // 安装/更新/查看/卸载后端
}
```

CLI 在以下时机启动独立子进程执行它：

| 命令 | action |
| --- | --- |
| `asg extensions install ...`（默认） | `install` |
| `asg extensions setup <id>` | `install` |
| `asg extensions setup <id> --status` | `status` |
| `asg extensions setup <id> --uninstall` | `uninstall` |
| `asg extensions remove <id>`（默认，先卸载后端） | `uninstall` |

> `asg plugins install/remove <name>` 只在 0.3.11–0.4.0 存在；0.4.1 已删除，不再触达 setup。

`update` 是契约预留的 action：插件应像 `install` 一样幂等处理，但当前 CLI 不会主动传
`update`（升级插件仓库时传的是 `install`）。不要依赖某个 action 只出现一次。

### 5.1 上下文

```ts
interface SetupContext {
  readonly action: "install" | "update" | "uninstall" | "status";
  readonly backends: string[];          // 本次选中的 backend id
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

`host` 刻意只有 `os` / `arch`，没有 `isWindows` 之类的派生字段；平台判断请用
`ctx.host.os`。`plugin` 与 `host` 是只读快照。

### 5.2 路径

| 字段 | 值 |
| --- | --- |
| `paths.root` | 安装根 |
| `paths.pluginDir` | `data/extensions/<id>`，只读 |
| `paths.dataDir` | `data/extension-data/<id>`，插件唯一可写数据目录 |
| `paths.backendDir(id)` | `data/extension-data/<id>/backends/<id>` |
| `paths.tempDir` | `data/extension-data/<id>/tmp` |
| `paths.config` | `<root>/gateway.yaml` |
| `paths.secrets` | `<root>/secrets.yaml` |

- 相对路径按 `paths.dataDir` 解析；写操作（`mkdir` / `remove` / `rename` / `writeFile` /
  `extract` / 下载目标 / `copy` 目标）只能落在 `dataDir` 或 `tempDir` 内，
  且会检查真实路径，符号链接逃逸会被拒绝。`rename` 的源路径也必须是可写路径。
- `pluginDir` 只能读，不能写。
- 0.4.1 起不再提供 `paths.legacyBackendDir(id)`：旧 `data/backends` 需要由用户自行迁移。

### 5.3 文件与下载

- `readFile` 默认 `utf8`，二进制用 `base64`；`writeFile` 接受字符串或 `Uint8Array`，
  会自动创建父目录，支持 `mode` / `append`。
- `mkdir` 默认 `recursive: true`；`remove` 默认 `recursive: true, force: true`。
- `sha256` 返回小写十六进制。
- `download` / `fetchText` / `fetchJson` **只接受 https**。`download` 提供 `sha256` 时，
  下载后会校验；不匹配会删除目标文件并报错。`fetchText` / `fetchJson` 也会先落临时文件再读取。
- `extract` 支持 `.tar.gz` / `.tgz` / `.zip`。`stripComponents` 只支持 tar；
  zip 会优先用 `unzip`，不可用时回退 `tar -xf`。
- `fetchJson` 返回值是 JSON 解析后的任意值，不是字符串。

### 5.4 运行子进程

```ts
const result = await ctx.run("example-cli", ["--version"], {
  cwd: ctx.paths.backendDir("example-cli"),
  timeoutMs: 120_000,
});
if (result.code !== 0) {
  throw new Error(`example-cli 安装失败：${result.stderr || result.stdout}`);
}
```

- `cwd` 按 `paths.dataDir` 解析，必须已经存在且是目录。
- `env` 与 `process.env` 合并；值设为 `undefined` 表示删除该变量。
- `timeoutMs` 默认 `600000`（10 分钟）；`0` 表示不限时。超时会先 `SIGTERM`，
  1.5 秒后 `SIGKILL`，返回 `timedOut: true`。
- `shell` 默认 `false`；只有确实需要 shell 解析时才设为 `true`。
- stdout / stderr 各最多保留 4 MiB，超过会截断并追加提示；插件应尽量输出简短日志。

### 5.5 配置写入

`ctx.config` 只操作 `gateway.yaml → extensions.<plugin.id>.config`：

- `get()`：读取当前值；缺省返回 `{}`。`gateway.yaml` 不存在会报错。
- `patch(value)`：递归合并（对象合并，数组/标量替换），返回合并后的完整配置。
- `replace(value)`：整体替换。
- `unset(paths)`：按点号路径删除，例如 `["retry.times"]`；空的父对象会被清理。
- 每次写入前都会用 manifest 的 `config_schema` 校验；校验失败会抛错，**不落盘**。
- 写入使用 YAML Document + 原子替换，尽量保留注释；不会写其他插件或顶层的配置。
- 没有 `config_schema` 时只要求值是对象。
- **不能**通过 `ctx.config` 写密钥；密钥仍走 `secrets.yaml`。

### 5.6 状态文件

- `ctx.state.read()` / `write(value)` 操作 `data/extension-data/<id>/state.json`；
  文件不存在时 `read()` 返回 `null`，`write()` 使用原子写。
- `ctx.backendState.read(id)` / `write(id, state)` / `clear(id)` 操作
  `data/extension-data/<id>/backends.json` 中按 backend id 索引的记录；
  `read` 缺省返回 `null`，`clear` 对不存在的 id 是空操作。
- `asg extensions list` 与 `asg plugins list` 只读 `backends.json` 与后端目录是否存在，
  不会执行插件代码。建议写入 `{ installed: true, enabled: true, version, path }` 这类字段；
  状态缺失时若 `data/extension-data/<id>/backends/<backend-id>/` 存在，仍按已安装展示；
  形状不合法时按未安装展示。
- `state` / `backendState` 的值必须是可 JSON 序列化的数据，`undefined` 会被拒绝。

### 5.7 幂等、可重跑与旧目录迁移

插件作者必须假设 setup 会被反复执行：

- `install` / `update` / `status` / `uninstall` 都要能在任意当前状态下重跑；
  已满足条件时直接返回，不要重复下载或重复改配置。
- 安装前先检查目标目录/版本；下载到 `tempDir`，校验后 `rename` 到最终位置；
  失败时不要留下半个可用目录。
- `uninstall` 只删自己安装在 `backendDir(id)` 下的内容，不要把整个
  `data/extension-data/<id>` 或 `data/backends` 删掉；用户数据是否保留由 CLI 决定。
- 兼容旧后端时，`data/backends/<name>` 是**只读迁移源**：只复制到新目录，
  不移动、不改写、不删除。重复执行时“目标已存在”应视为成功或按版本升级。

一个中性的最小示例（`example-plugin`，后端 `example-cli`）：

```ts
import path from "node:path";

export async function setup(ctx) {
  const id = "example-cli";
  const target = ctx.paths.backendDir(id);
  const legacy = ctx.paths.legacyBackendDir(id);

  if (ctx.action === "status") {
    const installed = await ctx.exists(target);
    if (!installed) return { installed: false };
    const state = await ctx.backendState.read(id);
    ctx.log(`example-cli 已安装：${target}`);
    return { installed: true, state };
  }

  if (ctx.action === "uninstall") {
    await ctx.remove(target, { recursive: true, force: true });
    await ctx.backendState.clear(id);
    ctx.log("example-cli 已卸载");
    return { removed: true };
  }

  // install / update：已经装好就直接复用。
  if (await ctx.exists(path.join(target, "example-cli"))) {
    ctx.log("example-cli 已存在，跳过安装");
    return { installed: true, reused: true };
  }

  await ctx.mkdir(target, { recursive: true });

  // 0.3.x 旧目录只读复制，不移动、不删除。
  if ((await ctx.exists(legacy)) && !(await ctx.exists(path.join(target, "example-cli")))) {
    await ctx.copy(legacy, target);
    ctx.log(`已从旧目录复制 example-cli：${legacy}`);
  }

  if (!(await ctx.exists(path.join(target, "example-cli")))) {
    const archive = path.join(ctx.paths.tempDir, "example-cli.tar.gz");
    await ctx.download("https://example.com/releases/example-cli.tar.gz", archive, {
      sha256: "<64 位十六进制 sha256>",
      label: "example-cli",
    });
    await ctx.extract(archive, target, { stripComponents: 1 });
    await ctx.remove(archive, { force: true });
  }

  const version = await ctx.run(path.join(target, "example-cli"), ["--version"], {
    cwd: target,
  });
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

### 5.8 子进程、超时与安全边界

- setup 在**独立 Node 子进程**中运行，父进程通过 IPC 提供文件/网络/进程/配置能力；
  worker 动态 import 插件入口并调用 `setup`。
- 整次 setup 默认超时 **600000ms（10 分钟）**；超时或完成后父进程会杀掉子进程。
  插件应在自己的 `run` 里设置更细的超时，避免整次 setup 被拖死。
- `setup` 的返回值会经过 `JSON.stringify` 处理：`undefined` 转成 `null`，函数属性会被
  丢弃；循环引用、BigInt 等无法序列化的值会报错。
- 子进程只是崩溃隔离/超时/日志转发，**不是安全沙箱**。插件代码仍能使用 Node 内置能力，
  文件与网络限制只是宿主 API 的防误用边界，不是权限隔离。只安装可信来源。
- 插件不得 import 网关内部模块，也不得依赖宿主 `node_modules` 中的非内置包；
  需要第三方库时 bundle 进入口文件。

## 6. 发布资产

一个插件 Release（推荐 tag 为 `v<version>`，例如 `v0.1.0`；安装器也兼容不带 `v` 的 tag）
至少包含三个资产：

| 资产 | 必填 | 说明 |
| --- | --- | --- |
| `asg-extension.json` | 是 | V2 manifest 本体（`api_version: 2`）；0.4.0 不再回退 `asg-plugin.json` |
| `index.mjs`（或 manifest `entry` 指定的文件名） | 是 | 单文件 ESM 产物；不能依赖同目录其它文件；可同时导出 `fetch` / `engine` / `setup` |
| `SHA256SUMS` | 是 | `sha256sum` 格式，必须覆盖 manifest 与 entry |

生成并发布示例：

```bash
npm ci
npm run build
sha256sum index.mjs asg-extension.json > SHA256SUMS
gh release create v0.2.0 index.mjs asg-extension.json SHA256SUMS
```

安装器会：

1. 解析 GitHub Release（指定版本时先查 `v<version>`，再回退到 `<version>`；否则查 `latest`）。
2. 下载 `asg-extension.json`，到 staging 并校验；缺失即失败，不再回退 V1 manifest。
3. 再下载 `entry` 与 `SHA256SUMS`。
4. 用 `SHA256SUMS` 校验 manifest 与 entry；缺失或不匹配立即失败并清理 staging。
5. 旧目录移到 `.trash-*`，staging 原子换到 `data/extensions/<id>/`；失败时回滚旧目录。
6. 安装成功后，如 manifest 声明了 `backends` 且没有 `--no-setup`，执行一次
   `setup(ctx)`（action=`install`，默认覆盖全部后端）。

所有下载地址只接受 **https**。下载复用 `scripts/install/http.mjs`，因此会自动遵循
`HTTPS_PROXY` / `https_proxy` 等代理变量。

限制：私有仓库的 Release 资产目前按 `browser_download_url` 下载，不会额外带
GitHub Release asset API 的鉴权；私有仓库安装暂不保证可用。

## 7. CLI

```text
asg extensions search [query] [--limit N]
asg extensions install <owner/repo>[@version] [--backend <id>]... [--no-setup]
asg extensions setup <id> [--backend <id>]... [--status] [--uninstall]
asg extensions list
asg extensions remove <id> [--keep-data] [--force]
asg extensions config <id> [--get [key]] [--set key=value]... [--unset key]... [--file <path>] [--describe]
asg extensions secret <id> --name <name> --stdin | --clear
```

### 7.1 `install`

- 从 `owner/repo` 的 GitHub Release 安装；`@version` 可锁定版本。
- `--backend <id>` 可重复，用来只 setup 部分后端；给未声明后端的插件传 `--backend`，
  或 id 不在 manifest 中，会报 `CONFIG_INVALID`（退出码 4）。
- 默认对 manifest 声明的**全部后端**执行 `action=install`；`--no-setup` 只跳过执行，
  仍会报告后端列表。
- setup 失败时命令返回 `PLUGIN_FAILED`（退出码 1），但**插件目录保留**；修复后可运行
  `asg extensions setup <id>` 重试。
- 安装完成不会自动重启网关。

人类输出示例：

```text
已安装 Example Plugin (example-plugin) v0.1.0
能力: fetch
后端: example-api, example-cli
路径: /path/to/root/data/extensions/example-plugin
setup: 已完成（action=install，后端 example-api, example-cli）
重启网关后生效。
```

JSON（`--json`）的 `data` 包含安装结果、`backends`（manifest 声明的全部 id）与
`setup` 报告；`setup.backends` 是本次实际执行的后端。

### 7.2 `setup`

- 对已安装插件单独执行 setup；默认 `action=install`。
- `--status` 切到 `status`，`--uninstall` 切到 `uninstall`，两者互斥。
- `--backend <id>` 可重复；未给时使用 manifest 声明的全部后端。
- 插件没有声明后端时直接报 `CONFIG_INVALID`（退出码 4），不启动子进程。
- 失败返回 `PLUGIN_FAILED`（退出码 1）；成功也不会自动重启网关。
- action 的语义由插件定义；推荐 `status` 只读并返回可读状态，`uninstall` 只删后端。

### 7.3 `list`

表格列固定为 `ID / VERSION / PROVIDES / BACKENDS / CHANNELS / ENGINES / ENTRY`。

- `BACKENDS` 每个后端渲染为 `<id>@<version>`（`backends.json` 有版本时）、
  `<id>`（已安装但无版本）或 `<id>(未安装)`；没有声明后端时显示 `-`。
- `CHANNELS` / `ENGINES` 输出 V2 manifest 的 `fetch_channels[].id` /
  `search_engines[].id`；0.4.0 不再有 V1 条目。
- 读取 `data/extension-data/<id>/backends.json`，**不执行任何插件代码**。
- 状态文件缺失按“未安装”处理；损坏时在 stderr/`reporter.info` 告警，列表仍可用。
- JSON 返回 `{ "extensions": [...] }`；每个后端条目包含 manifest 的
  `id` / `name` / `description` / `aliases`，并附加
  `installed` / `enabled`，有值时附加 `version` / `path`。
- 扩展同时返回 `fetch_channels` 与 `search_engines`；0.4.0 不再有 V1 条目。

### 7.4 `remove`

- 默认先对全部已声明后端执行 `action=uninstall`；成功后才删除插件目录。
  卸载 setup 失败时不删除插件，返回 `PLUGIN_FAILED`。
- `--force` 跳过卸载 setup，直接删除插件目录；manifest 损坏时也用它跳过。
- 插件目录删除后，默认删除 `data/extension-data/<id>`；`--keep-data` 保留。
- 不修改 `gateway.yaml` / `secrets.yaml`；`extensions.<id>.config` 与密钥会保留，
  需要时手动清理。
- 不会删除 `data/backends`（旧目录）。
- 不自动重启网关。

### 7.5 `config` / `secret`

- `config`：读写 `gateway.yaml → extensions.<id>.config`。
  - 无参数：输出补齐默认值后的完整配置；
  - `--get [key]`：只输出一个字段（支持 `retry.times` 这类点号路径）；不给 key 时输出整份配置；
  - `--set key=value`：可重复，值先按 JSON 解析，失败按字符串；
  - `--unset key`：可重复；
  - `--file <path>`：用 YAML/JSON 文件整体替换配置；
  - `--describe`：列出 schema 的顶层字段（类型、必填、默认值、说明）。
- `secret`：写/删 `secrets.yaml → extensions.<id>.<name>`。值只从 stdin 读，
  末尾一个换行会被去掉；`--clear` 删除；输出不回显明文。
- 两者都是**先整体校验、再写一次文件、最后整栈重启一次**；校验失败不落盘、不重启。
  `secret` 写入的 `secrets.yaml` 权限固定为 `0600`。

### 7.6 `asg plugins`（0.4.1 起已删除）

`asg plugins list|install|remove` 在 0.3.11–0.4.0 作为兼容 facade 存在；**0.4.1 已连同
`scripts/backends/` 与 `data/backends` 默认读取一起删除**，CLI 不再接受该命令。

后端统一由插件 manifest 的 `backends` 声明，并通过 `setup(ctx)` 安装/更新/卸载：

```bash
asg extensions install <owner/repo>[@version]
asg extensions setup <id> [--backend <id>]... [--status] [--uninstall]
```

旧安装名仍可写在 `backends[].aliases` 里，供扩展命令与历史配置识别；但不会再回退到
`scripts/backends/cli.mjs`。

### 7.7 重启矩阵

| 命令 | 自动重启 |
| --- | --- |
| `extensions install` / `setup` / `remove` | 否，重启网关后生效 |
| `extensions config` / `secret` | 是，整栈重启一次 |

所有子命令都支持全局 `--json`（输出单个 result 对象）；`config` / `secret` 的 JSON 字段
见 `docs/cli-contract.md` 5.6.1。

### 7.8 GitHub API 限流

`search` 以及私有仓库的 Release 查询会读取 `GITHUB_TOKEN`（或 `GH_TOKEN`）。
未设置 token 时 GitHub 对匿名请求限制较严；遇到 403 / 429 时请设置 token 后重试：

```bash
export GITHUB_TOKEN=ghp_xxx
```

请求头固定包含 `Accept: application/vnd.github+json`、
`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: asg/<version>`；有 token 时加
`Authorization: Bearer <token>`。

## 8. 安全与边界

- manifest 的 `id`、`backends[].id` 与 `entry` 都做了路径约束，安装目录不会逃出
  `data/extensions/`；setup 的写操作被限制在插件自己的 `data/extension-data/<id>`。
- 只接受 https 资产地址，并用 `SHA256SUMS` 校验 manifest 与 entry；setup 下载同样只允许 https，
  推荐始终提供 `sha256`。
- 官方 id（`bilibili` / `weibo` / `cnki`）与普通第三方 id 一样安装/卸载。
- 插件代码在网关进程内 import，**没有沙箱**；可读取宿主注入的
  `ctx.pluginConfig` / `ctx.pluginSecrets`（内置实现另用 `ctx.settings` / `ctx.secrets` / `getSecret()`）。
  只安装可信来源。
- setup 在独立子进程中运行，但同样**不是安全沙箱**；它继承用户权限，可执行任意命令。
  宿主只限制通过 `ctx` API 的写入路径，不限制插件直接使用 Node 能力。
- `data/backends` 是旧安装目录：通过 `ctx` API 只能读/复制，不能写入；CLI 不会主动删除。
  但 setup 子进程不是沙箱，插件不应绕过 `ctx` 去改旧目录。
- `config_schema` / `extensions.<id>.config` **不放密钥**；密钥一律写
  `secrets.yaml → extensions.<id>.<name>`，用 `asg extensions secret --stdin` 输入，
  不进 argv、不回显。

## 9. 运行时加载

网关启动时（`createServer` 首次调用，进程级只执行一次）以及 `asg engines list|enable|disable|route|secret`
会扫描 `data/extensions`：

1. 发现 `data/extensions/<id>/asg-extension.json`（`api_version: 2`），
   目录名必须等于 `manifest.id`；`asg-plugin.json` 在 0.4.0 不再被发现。
2. 按 manifest id 读取 `gateway.yaml → extensions.<manifest id>.config`，
   用 `config_schema` 校验并补默认值；非法配置直接跳过该插件（不 import 入口）。
3. 解析 `secrets.yaml → extensions.<id>.<name>`（只按 manifest id），解析
   `env:NAME`，空值不注入。
4. `import()` 安装目录内 `entry` 指向的文件（单个 ESM 文件，不得引用其它插件文件）。
   `setup` 导出不会在加载阶段执行。
5. 按 `provides` 读取命名导出：
   - `fetch`：`FetchProvider` 对象（`match` / `enabled` / `available` / `fetch`），manifest 覆盖 `id` / `name` / `displayName`；
     platform 优先级为入口 `platform` > `fetch_channels[0].id` 前缀 > `manifest.id`；
   - `engine`：搜索源对象（`id` / `group` / `name` / `runtime` 等）；用匹配的
     `search_engines[].name` 补 `displayName`。扩展引擎的启用路径与依赖优先读
     `enabledPathV2` / `requiresV2`（指向 `extensions.<id>.*`），旧 `enabledPath` /
     `requires` 只用于 0.3.x 兼容。
6. V2 声明了 `backends` 时，构造 `pluginBackends`（`ids` / `dir` / `state`）；
7. 注入上下文：包装 `enabled` / `available` / `fetch` / `runtime`，把 `pluginConfig`
   （递归冻结）、`pluginSecrets` 与 `pluginBackends` 放进 `FetchProviderContext` /
   `EngineProviderContext`。`match(url)` 保持原函数，不读上下文。
8. 同一批外部插件内 id 重复视为扩展自身错误；重复插件会被跳过并记录错误。
9. 单个插件加载失败只影响该插件，不影响网关启动与其它插件。

只有声明了 `config_schema`，或存在非空 `config` / 非空密钥 / 路由覆盖 / `secret:` 依赖，
或 V2 声明了 `backends` 时，provider 才会被包装；没有这些内容的插件保持原对象，
行为与插件自身实现完全一致。

引擎插件的用户级覆盖进 `extensions` 段，键的语义不同：

```bash
asg engines route gateway.search:weibo --category news --hot-category news_hot
asg engines secret gateway.search:weibo --name cookie --stdin
asg extensions config weibo --set limit=20
asg extensions secret weibo --name cookie --stdin
```

- `routing` 写入 `gateway.yaml` 的 `extensions.<engineId>.routing`，覆盖插件的 `routing()` / `plan()`；
- 私有配置写入 `gateway.yaml` 的 `extensions.<manifest id>.config`，运行期通过
  `ctx.pluginConfig` 注入；
- 密钥写入 `secrets.yaml` 的 `extensions.<manifest id>.<name>`，支持 `env:NAME`，
  运行期通过 `ctx.pluginSecrets` 注入；插件用 `requires: ["secret:<name>"]` 声明依赖。
  `asg engines enable` 的依赖检查也只认 manifest id 键。

插件不得 import 网关内部模块，也不得依赖宿主 `node_modules` 中的非内置包；
需要跨进程能力时应通过 CLI / HTTP 自行实现。

插件模板见 [`examples/asg-plugin/`](../examples/asg-plugin/)，发布时请给仓库加 `asg-plugin` topic。

## 10. 迁移与兼容（0.3.x → 0.4.x）

- **升级顺序**：先升到 0.3.11，运行 `scripts/migrations/0.3.x.mjs`（至少 `--phase config`），
  把官方插件升到 0.2.x，再安装 0.4.0 或更高版本。迁移脚本只存在于 0.3.11–0.4.0。
- **旧后端目录**：0.3.x 的插件后端在 `data/backends/<name>`。新契约下后端由插件 setup
  安装到 `data/extension-data/<id>/backends/<backend-id>`；**0.4.1 起不再读取旧目录**，
  也不主动删除，需要时请自行迁移或清理。
- **旧 CLI 名称**：`asg plugins install/remove <name>` 只在 0.3.11–0.4.0 存在；
  **0.4.1 已删除 `asg plugins`、`scripts/backends/` 与 `data/backends` 默认读取。**
- **临时迁移脚本**：`scripts/migrations/0.3.x.mjs` 按
  `preflight → plugins → backends → config → restart` 执行；`config` 阶段把
  `bilibili` / `weibo` / `search.weibo` 与旧 bilibili 密钥迁到 `extensions.<id>`。
  **0.4.1 已删除整个目录**；已升级到 0.4.1 的用户只能手工迁移，或临时回到 0.3.11。
- **已发生的清理**：0.4.0 移除 V1 manifest / V1 加载、旧平台配置键与
  `secrets.yaml` 的旧 bilibili 段；0.4.1 再移除 `asg plugins`、`scripts/backends/`、
  `scripts/migrations/`、setup 的 `legacyBackendDir` 与 `data/backends` 默认迁移读取。

相关决策见 `docs/adr/0022-plugin-owned-backends-and-setup-hook.md`；旧的后端安装脚本
背景见 `docs/adr/0016-backend-install-and-self-update.md`（已由 0022 过渡接管）。
