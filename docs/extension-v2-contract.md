# Extension V2 接口契约

- 状态：0.4.0 起为运行期唯一契约
- 当前版本：0.4.0 只接受 V2 manifest（`asg-extension.json`，`api_version: 2`）
- 过渡：`asg plugins`、`scripts/backends/`、`scripts/migrations/` 在 0.4.0 保留并标记
  deprecated，**0.4.1 删除**
- 本文描述最终接口；0.3.x 的 V1 兼容仅保留在历史文档中

---

## 0. 范围

本文定义：

- V2 manifest 自描述
- 运行时 `FetchProvider` / `FetchChannel` / `EngineProvider` 接口
- catalog 只读模型
- setup 钩子接口
- 存储与配置接口
- CLI 对外语义
- V1/V2 过渡接口
- 迁移清单接口

本文不定义：

- 官方平台插件实现
- setup 内部实现细节
- 迁移脚本逐阶段实现
- GUI

---

## 1. 术语与边界

### 1.1 四个实体

| 实体 | 含义 | 是否可安装 |
| --- | --- | --- |
| `extension` | 扩展包，manifest + entry | 是 |
| `backend` | 扩展拥有的外部依赖 | 是，由 setup 管理 |
| `fetch channel` | 扩展暴露的抓取通道 | 否，运行时路由 |
| `search engine` | 扩展暴露的搜索源 | 否，运行时 provider |

V2 不再用 `plugin` 指代安装单元。

### 1.2 最终态约束

- `src/` 不出现具体第三方平台、站点、CLI、后端名。
- 平台、通道、搜索源、后端元数据全部来自扩展 manifest。
- 扩展文件层不依赖 CLI、server、settings、fetch、engines、search。
- 运行时通过独立 adapter 接入 fetch / engines。
- 官方扩展实现不在本仓库。

### 1.3 层级

```text
extensions/domain     纯类型、manifest、校验、catalog 模型
extensions/store      文件布局、安装/卸载、catalog 读取
extensions/setup      setup 子进程与宿主能力
extensions/runtime    fetch / engines 运行时 adapter
cli adapter           命令、输出、错误码、重启
```

依赖方向：

```text
cli / server / runtime adapter
        ↓
extensions 公共 API
        ↓
domain / store / setup
```

反向禁止：

- `domain` / `store` / `catalog` / `manifest` / `setup` 不得 import CLI、server、settings、fetch、engines、search。
- 其他模块不得直接 import extensions 内部实现。

---

## 2. Manifest

文件名：

```text
V2: asg-extension.json
V1: asg-plugin.json
0.3.x 安装器: 优先 asg-extension.json，回退 asg-plugin.json
0.4.0: 只接受 asg-extension.json
```

### 2.1 共享描述接口

```ts
/** 实体级人类可读摘要；只用于展示，不参与解析。 */
interface Described {
  /**
   * 展示优先级：
   * 实体自己的 description
   * -> 所属扩展的 description
   * -> 空字符串
   */
  description?: string;
}
```

### 2.2 V2 manifest

```ts
interface ExtensionManifestV2 extends Described {
  /** 扩展唯一 ID；同时是 data/extensions/<id> 目录名，安装后不可变。 */
  id: string;

  /** 展示名；只用于列表和目录，不参与路径或身份解析。 */
  name: string;

  /** 语义化版本；Release tag 去掉 v 后必须一致。 */
  version: string;

  /** 契约版本；V2 固定为 2。 */
  api_version: 2;

  /** 扩展能力：search 需要 search_engines，fetch 需要 entry 导出 fetch。 */
  provides: ("search" | "fetch")[];

  /** 单文件 ESM 入口；相对扩展目录，不能带路径分隔符。 */
  entry: string;

  /** 外部依赖声明；省略或空数组表示无外部后端。 */
  backends?: ExtensionBackend[];

  /** 抓取通道声明；省略或空数组表示不声明 fetch 通道。 */
  fetch_channels?: ExtensionFetchChannel[];

  /** 搜索源声明；provides 含 search 时必填。 */
  search_engines?: ExtensionSearchEngine[];

  /** 扩展私有配置的 JSON Schema 子集；值写入 extensions.<id>.config。 */
  config_schema?: Record<string, unknown>;
}
```

### 2.3 Backend

```ts
interface ExtensionBackend extends Described {
  /** 后端 ID；扩展内唯一；用于 setup 的 backendDir(id) 和 backends.json 键。 */
  id: string;

  /** 展示名；不参与身份解析。 */
  name: string;

  /** 旧安装名/输入别名；只用于迁移和 legacy 解析，不参与安装路径。 */
  aliases?: string[];
}
```

### 2.4 Fetch channel

```ts
interface ExtensionFetchChannel extends Described {
  /** 规范通道 ID：platform:channel；同一扩展内所有 channel 的 platform 必须一致。 */
  id: string;

  /** 展示名；缺省用 id。 */
  name?: string;

  /** 该通道拥有的 backend id；缺省 [] 表示无外部后端；同一 backend 不能出现在多个 channel。 */
  backends?: string[];

  /** 通道输入别名；不能映射到不同 channel。 */
  aliases?: string[];
}
```

### 2.5 Search engine

```ts
interface ExtensionSearchEngine extends Described {
  /** 规范搜索源 ID：group:name；group 只能是 gateway.search / gateway.reverse_image。 */
  id: string;

  /** 展示名；缺省用 id。 */
  name?: string;
}
```

### 2.6 校验规则

- `api_version` 必须为 `2`。
- `id`、`version`、`entry`、`provides` 按现有扩展规则校验。
- `backends[].id` 唯一。
- `backends[].aliases` 非空、去重。
- `fetch_channels[].id` 必须为 `platform:channel`。
- 同一扩展内所有 channel id 的 platform 前缀必须一致。
- `fetch_channels[].backends` 可省略或为空。
- 非空时：元素唯一、必须存在于 `backends[]`、不能跨 channel 共用。
- 一个 backend 可以不被任何 channel 引用。
- channel alias 不能映射到不同 channel。
- `provides` 含 `search` 时，`search_engines` 必须非空。
- `search_engines[].id` 必须为 `gateway.search:*` 或 `gateway.reverse_image:*`。
- search engine id 在同一扩展内唯一。
- 未知字段严格拒绝。
- `backends` 非空时，entry 必须导出 `setup`。

### 2.7 示例：完整自描述

```json
{
  "id": "example-plugin",
  "name": "Example",
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
  ],
  "config_schema": {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true,
        "description": "总开关"
      }
    }
  }
}
```

### 2.8 示例：无后端

```json
{
  "id": "example-http",
  "name": "Example HTTP",
  "version": "0.2.0",
  "api_version": 2,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "fetch_channels": [
    {
      "id": "example:http",
      "name": "Example HTTP",
      "description": "纯 JS/HTTP 抓取"
    }
  ]
}
```

---

## 3. 运行时接口

### 3.1 FetchProvider

```ts
interface FetchProvider {
  /** 运行时扩展 ID；必须等于 manifest.id。 */
  id: string;

  /** 平台回退值；缺省时由 manifest channel 前缀或 manifest.id 决定。 */
  platform?: string;

  /** 展示名；缺省由 manifest.name 决定。 */
  displayName?: string;

  /** 纯 URL 判断是否接管；不读配置、不抛业务错误。 */
  match(url: URL): boolean;

  /** 实际抓取实现；配置和密钥通过 ctx 注入。 */
  fetch(url: URL, ctx: FetchProviderContext): Promise<FetchProviderResult>;

  /** 可选运行通道对象；存在时 id 集合必须与 manifest.fetch_channels 一致。 */
  channels?: readonly FetchChannel[];
}
```

### 3.2 FetchChannel

```ts
interface FetchChannel {
  /** 规范通道 ID：platform:channel；必须与 manifest 对应项一致。 */
  id: string;

  /** 从 id 前缀派生。 */
  platform: string;

  /** 从 id 后缀派生。 */
  channel: string;

  /** 展示名。 */
  displayName: string;

  /** 实现形态；只在运行时使用，不写 manifest。 */
  kind: "cli" | "http" | "session";

  /** 通道能力；只在运行时使用，不写 manifest。 */
  capabilities: readonly string[];

  /** 通道输入别名；只在运行时使用。 */
  aliases?: readonly string[];

  /** 可选健康探测。 */
  probe?(ctx: ChannelContext): Promise<ChannelProbe>;

  /** 可选资源释放。 */
  dispose?(): Promise<void>;
}
```

### 3.3 EngineProvider

```ts
interface EngineProvider {
  /** `${group}:${name}`；必须与 manifest.search_engines[].id 一致。 */
  id: string;

  /** 搜索源分组；只允许 gateway.search / gateway.reverse_image。 */
  group: "gateway.search" | "gateway.reverse_image";

  /** 搜索源名；与 id 后缀一致。 */
  name: string;

  /** 展示名。 */
  displayName: string;

  /** 运行期能力；不写入 manifest。 */
  runtime: EngineRuntime;

  /** 可选路由。 */
  routing?(ctx): string[];

  /** 可选可用性检查。 */
  available?(ctx): boolean;

  /** 可选启用状态。 */
  enabled?(ctx): boolean;

  /** 可选启用路径。 */
  enabledPath?: readonly string[];
}
```

### 3.4 一致性规则

- manifest `fetch_channels` 是静态身份与归属。
- 运行时 `FetchChannel` 是实现形态、能力、探测、释放。
- manifest 不复制 `kind` / `capabilities`。
- entry 导出 `channels` 时，id 集合必须与 manifest `fetch_channels` 一致。
- entry 不导出 `channels` 时，manifest 仅作目录元数据。
- search engine 的 `id` / `group` / `name` 必须与 manifest `search_engines` 一致。
- platform 优先级：
  1. entry `FetchProvider.platform`
  2. manifest `fetch_channels[0].id` 前缀
  3. `manifest.id`
- 多个不同前缀直接报错。

---

## 4. Catalog 接口

### 4.1 组合原则

```text
manifest                     唯一事实来源
ExtensionIdentity            manifest 中身份字段的规范化视图
ExtensionBackend             manifest 中的 backend 声明
ExtensionFetchChannel        manifest 中的 fetch channel 声明
ExtensionSearchEngine        manifest 中的 search engine 声明

ExtensionStatus              identity + path + 状态
BackendStatus                spec + 安装状态
FetchChannelStatus           spec + 派生 platform/channel + 状态
SearchEngineStatus           spec + 派生 group
CLI JSON                     展示层扁平投影，不是数据模型
```

### 4.2 ExtensionIdentity

```ts
interface ExtensionIdentity extends Described {
  /** manifest.id；安装目录名。 */
  id: string;

  /** manifest.name；展示名。 */
  name: string;

  /** manifest.version。 */
  version: string;

  /** manifest.provides。 */
  provides: ExtensionProvide[];

  /** 入口文件名。 */
  entry: string;

  /** manifest.config_schema 的规范化命名。 */
  configSchema?: Record<string, unknown>;
}
```

### 4.3 Catalog

```ts
interface ExtensionCatalog {
  /** 已安装扩展的 identity + 状态。 */
  extensions: ExtensionStatus[];

  /** 所有扩展的 backend 扁平视图。 */
  backends: BackendStatus[];

  /** 所有扩展的 fetch channel 扁平视图。 */
  channels: FetchChannelStatus[];

  /** 所有扩展的 search engine 扁平视图。 */
  search_engines: SearchEngineStatus[];
}
```

### 4.4 ExtensionStatus

```ts
interface ExtensionStatus {
  /** 规范化身份；id/name/version/description/provides/entry 的唯一来源。 */
  identity: ExtensionIdentity;

  /** 安装目录绝对路径。 */
  path: string;

  /** 该扩展声明的 backend 及其状态。 */
  backends: BackendStatus[];

  /** 该扩展声明的 fetch channel 及其状态。 */
  fetch_channels: FetchChannelStatus[];

  /** 该扩展声明的 search engine。 */
  search_engines: SearchEngineStatus[];

  /** 单个扩展目录损坏时的错误；只影响该条。 */
  error?: string;
}
```

### 4.5 BackendStatus

```ts
interface BackendStatus {
  /** manifest 中的 backend 声明；id/name/description/aliases 的唯一来源。 */
  spec: ExtensionBackend;

  /** 由 backends.json 的 installed 或后端目录存在推导。 */
  installed: boolean;

  /** 由 backends.json 的 enabled 推导；缺失时为 false。 */
  enabled: boolean;

  /** 插件写入的后端版本；可缺省。 */
  version?: string;

  /** 插件写入的后端安装路径；可缺省。 */
  path?: string;
}
```

### 4.6 FetchChannelStatus

```ts
interface FetchChannelStatus {
  /** manifest 中的 fetch channel 声明；id/name/description/backends/aliases 的唯一来源。 */
  spec: ExtensionFetchChannel;

  /** 从 spec.id 前缀派生。 */
  platform: string;

  /** 从 spec.id 后缀派生。 */
  channel: string;

  /** 所属扩展的 manifest.id。 */
  extension_id: string;

  /** 该 channel 拥有的 backend id；无后端时为空数组。 */
  backend_ids: string[];

  /** 所有 backend 已安装；无 backend 时为 true。 */
  installed: boolean;

  /** 所有 backend enabled；无 backend 时为 true。 */
  enabled: boolean;

  /** backend_ids 中的第一个后端状态；无 backend 时可缺省。 */
  primary_backend?: BackendStatus;
}
```

### 4.7 SearchEngineStatus

```ts
interface SearchEngineStatus {
  /** manifest 中的 search engine 声明；id/name/description 的唯一来源。 */
  spec: ExtensionSearchEngine;

  /** 从 spec.id 前缀派生。 */
  group: string;

  /** 所属扩展的 manifest.id。 */
  extension_id: string;
}
```

### 4.8 状态语义

- `BackendStatus.installed`：`backends.json.installed === true` 或后端目录存在。
- `BackendStatus.enabled`：`backends.json.enabled === true`；缺失时 `false`。
- `FetchChannelStatus.installed`：所有 `backend_ids` 已安装；无 backend 时为 `true`。
- `FetchChannelStatus.enabled`：所有 `backend_ids` enabled；无 backend 时为 `true`。
- `primary_backend`：`backend_ids` 中的第一个；无 backend 时缺省。
- catalog 不执行扩展代码。
- catalog 不持久化；每次从磁盘读取。

---

## 5. Setup 接口

### 5.1 Action

```ts
type SetupAction =
  | "install"      // 首次安装：扩展目录不存在
  | "update"       // 覆盖安装：扩展目录已存在且版本变化
  | "uninstall"    // 卸载：删除后端与插件私有状态
  | "status";      // 只查询：不得写文件、不得下载、不得执行安装动作
```

### 5.2 Context

```ts
interface SetupContext {
  /** 本次执行的动作；插件必须按 action 幂等处理。 */
  action: SetupAction;

  /** 本次选中的 backend id；默认全量，--backend 可缩小范围。 */
  backends: string[];

  /** 扩展身份；id/version 来自 manifest，不可伪造。 */
  extension: { id: string; name: string; version: string };

  /** 宿主平台；只暴露 os/arch。 */
  host: { os: "linux" | "darwin" | "win32"; arch: string };

  paths: {
    /** 安装根；插件不应直接读写根目录。 */
    root: string;

    /** 扩展安装目录；只读，位于 data/extensions/<id>。 */
    extensionDir: string;

    /** 扩展可写数据目录；位于 data/extension-data/<id>。 */
    dataDir: string;

    /** 指定 backend 的安装目录；由宿主校验，必须位于 dataDir 内。 */
    backendDir(id: string): string;

    /** 插件临时目录；随扩展数据保留，由插件自行清理。 */
    tempDir: string;

    /** gateway.yaml 路径；只能通过 ctx.config 写入 extensions.<id>.config。 */
    config: string;

    /** secrets.yaml 路径；只读路径，密钥写入仍走 extensions secret。 */
    secrets: string;
  };

  /** 写宿主日志；转发到 CLI reporter。 */
  log(message: string): void;

  /** 汇报阶段进度；不影响结果。 */
  progress(phase: string, detail?: string): void;

  /** 文件能力；写入受 dataDir/tempDir 限制，extensionDir 只读。 */
  exists / mkdir / remove / rename / copy / readFile / writeFile / sha256 / extract;

  /** 下载到指定路径；只允许 https，可选 sha256 校验。 */
  download(url, dest, opts);

  /** 拉取文本/JSON；用于版本检查、清单读取。 */
  fetchText(url, opts);
  fetchJson(url, opts);

  /** 执行外部命令；支持 cwd/env/timeout，默认 shell=false。 */
  run(command, args, opts);

  /** 插件私有配置；写入 extensions.<id>.config，并按 config_schema 校验。 */
  config: {
    get(): Record<string, unknown>;
    patch(value: Record<string, unknown>): void;
    replace(value: Record<string, unknown>): void;
    unset(paths: string[]): void;
  };

  /** 插件自由状态；写入 extension-data/<id>/state.json。 */
  state: {
    read(): unknown;
    write(value: unknown): void;
  };

  /** 后端安装状态；写入 extension-data/<id>/backends.json。 */
  backendState: {
    read(id: string): unknown;
    write(id: string, state: unknown): void;
    clear(id: string): void;
  };
}
```

### 5.3 边界

- setup 在独立子进程 + IPC 中执行。
- 默认超时 10 分钟。
- 不是安全沙箱。
- 写操作限制在 `dataDir` / `tempDir`。
- `extensionDir` 只读。
- V2 不提供 `legacyBackendDir`。
- `status` 不得写文件、不得下载、不得执行安装动作。

---

## 6. 存储与配置

### 6.1 目录

```text
data/
├── extensions/<extension-id>/
│   ├── asg-extension.json
│   └── <entry>
├── extension-data/<extension-id>/
│   ├── state.json
│   ├── backends.json
│   ├── backends/<backend-id>/
│   └── tmp/
```

V2 没有：

```text
data/extension-data/
data/backends/
asg-plugin.json
```

### 6.2 配置

```text
gateway.yaml
  extensions.<extension-id>.config

secrets.yaml
  extensions.<extension-id>.<name>
```

规则：

- 配置按 `config_schema` 校验。
- 默认值只在运行期补齐，不写回文件。
- secrets 权限 `0600`。
- config / secret 写入后整站重启。
- extension 生命周期不自动重启。

### 6.3 backends.json

```json
{
  "example-cli": {
    "installed": true,
    "enabled": true,
    "version": "1.0.0",
    "path": "/.../extension-data/example-plugin/backends/example-cli"
  }
}
```

- 插件 setup 写入。
- 核心只读。
- 缺失或损坏时按未安装展示，不影响 list。

---

## 7. CLI 接口

### 7.1 V2 命令

```text
asg extensions install <owner/repo>[@version] [--backend <id>]... [--no-setup]
asg extensions setup <id> [--backend <id>]... [--status] [--uninstall]
asg extensions list
asg extensions remove <id> [--keep-data] [--force]
asg extensions config <id> ...
asg extensions secret <id> ...
```

0.4.0 过渡期仍保留（deprecated），0.4.1 删除：

- `asg plugins`
- `scripts/backends` 回退
- `data/backends` 默认迁移读取
- `scripts/migrations/`

### 7.2 重启矩阵

| 命令 | 自动重启 |
| --- | --- |
| `extensions install` / `setup` / `remove` | 否 |
| `extensions config` / `secret` | 是，整站重启一次 |
| `extensions list` | 否，只读 |

### 7.3 `extensions list --json`

展示层可以扁平投影；数据模型仍使用 `identity` / `spec`。

```json
{
  "extensions": [
    {
      "id": "example-plugin",
      "name": "Example",
      "version": "0.2.0",
      "description": "示例扩展",
      "provides": ["fetch"],
      "path": "data/extensions/example-plugin",
      "backends": [
        {
          "id": "example-cli",
          "name": "Example CLI",
          "description": "示例命令行后端",
          "aliases": ["example"],
          "installed": true,
          "enabled": true,
          "version": "1.0.0"
        }
      ],
      "fetch_channels": [
        {
          "id": "example:cli",
          "platform": "example",
          "channel": "cli",
          "name": "Example CLI",
          "description": "通过本地 CLI 抓取",
          "aliases": ["example"],
          "extension_id": "example-plugin",
          "backend_ids": ["example-cli"],
          "installed": true,
          "enabled": true
        }
      ],
      "search_engines": []
    }
  ]
}
```

---

## 8. V1 / V2 过渡接口

### 8.1 V1 manifest

```ts
interface ExtensionManifestV1 extends Described {
  /** 扩展唯一 ID；安装目录名。 */
  id: string;

  /** 展示名。 */
  name: string;

  /** 语义化版本。 */
  version: string;

  /** 旧契约版本；V1 固定为 1。 */
  api_version: 1;

  /** 扩展能力；V1 只支持 search / fetch。 */
  provides: ("search" | "fetch")[];

  /** 单文件 ESM 入口。 */
  entry: string;

  /** 平台回退值；V1 专属。 */
  platform?: string;

  /** 插件私有配置的 JSON Schema 子集。 */
  config_schema?: Record<string, unknown>;
}
```

禁止：`backends`、`fetch_channels`、`search_engines`、`aliases`。

### 8.2 Descriptor

```ts
interface ExtensionDescriptor {
  /** 规范化身份；id/name/version/description/provides/entry/configSchema 的唯一来源。 */
  identity: ExtensionIdentity;

  /** 来源契约版本；只用于诊断，不用于分支逻辑。 */
  apiVersion: 1 | 2;

  /** 平台回退值；V1 来自 manifest.platform，V2 从 channel id 派生。 */
  platform?: string;

  /** 后端列表；V1 为空，V2 来自 manifest。 */
  backends: ExtensionBackend[];

  /** 抓取通道列表；V1 为空，V2 来自 manifest。 */
  fetchChannels: ExtensionFetchChannel[];

  /** 搜索源列表；V1 为空，V2 来自 manifest。 */
  searchEngines: ExtensionSearchEngine[];
}
```

Adapter 规则：

- V1：backends / channels / engines 全为空；platform = `manifest.platform ?? identity.id`。
- V2：直接映射；platform 从 channel id 派生。
- catalog、CLI、迁移只消费 `ExtensionDescriptor`。
- 业务代码不散落 `api_version` 判断。

### 8.3 版本边界

| 版本 | 接受 | 0.4.0/0.4.1 边界 |
| --- | --- | --- |
| 0.3.x | V1 + V2 | 不删兼容 |
| **0.4.0** | **仅 V2** | 删除 V1 加载、`asg-plugin.json`、旧平台配置键；`asg plugins` / `scripts/backends/` / `scripts/migrations/` 保留为 deprecated |
| 0.4.1 | 仅 V2 | 删除 `asg plugins`、`scripts/backends/`、`scripts/migrations/`、`data/backends` 默认迁移读取 |

### 8.4 文件兼容

| 版本 | 文件 |
| --- | --- |
| V1 / 0.3.7 | `asg-plugin.json` |
| V2 | `asg-extension.json` |
| 0.3.x 安装器 | 优先 `asg-extension.json`，回退 `asg-plugin.json` |
| 0.4.0 | 只接受 `asg-extension.json` |

### 8.5 目录兼容

```text
data/extensions/<id>/              V1 + V2 共用
data/extension-data/<id>/          V2 数据
data/backends/<name>/              V1 旧后端，只读迁移源
```

- `data/extension-data` 是最终命名；旧的 `data/plugin-data` 不再使用。
- V2 setup 可读取 `data/backends`，复制到 `extension-data/<id>/backends/<backend-id>`。
- 不移动、不删除旧目录。

---

## 9. 迁移清单接口

```ts
interface MigrationChecklist {
  /** 清单结构版本；1 = 只有升级目标，2 = 增加 config/secrets 映射。 */
  schema: 1 | 2;

  /** 迁移目标；只处理已安装且命中的扩展。 */
  plugins: Array<{
    /** 扩展 ID；必须与已安装 manifest.id 一致。 */
    id: string;

    /** GitHub 仓库 owner/name。 */
    repo: string;

    /** 目标版本；官方 v0.2.0 发布后填写。 */
    version: string;

    /** 旧 gateway.yaml 路径 -> extensions.<id>.config 路径。 */
    config?: Array<{
      /** 旧配置点号路径，如 example.cli.command。 */
      from: string;

      /** 目标配置点号路径，相对 extensions.<id>.config。 */
      to: string;

      /** 目标已存在且值不同时是否覆盖；默认 false。 */
      overwrite?: boolean;
    }>;

    /** 旧 secrets.yaml 路径 -> extensions.<id>.<name> 密钥。 */
    secrets?: Array<{
      /** 旧密钥点号路径，如 example.http.token。 */
      from: string;

      /** 目标密钥名，写入 extensions.<id>.<name>。 */
      to: string;

      /** 目标已存在且值不同时是否覆盖；默认 false。 */
      overwrite?: boolean;
    }>;
  }>;
}
```

规则：

- schema 1：无 config/secrets，config 阶段跳过。
- schema 2：执行 config/secrets 迁移。
- 新代码同时读 1 / 2。
- 只处理已安装且命中的扩展。
- 不擅自安装未安装扩展。

---

## 10. 兼容与弃用

### 10.1 V2 保留

- `api_version: 2`
- `asg-extension.json`
- `backends` / `fetch_channels` / `search_engines`
- `aliases`
- `extensions` CLI

### 10.2 V2 不包含

- `platform`
- `aliases`
- `kind`
- `capabilities`
- `CatalogChannel`
- `PluginStatus`
- `asg plugins`（0.4.0 仅保留 deprecated facade，0.4.1 删除）
- `data/plugin-data`
- `data/backends`（0.4.0 仅只读迁移源，0.4.1 删除默认读取）
- `asg-plugin.json`（0.4.0 起不再加载）

### 10.3 0.4.0 / 0.4.1 清理

**0.4.0 已完成：**

- 只接受 V2 manifest（`asg-extension.json`，`api_version: 2`）。
- 删除 V1 adapter 与 `asg-plugin.json` 回退。
- 删除旧平台配置键（`gateway.yaml` 顶层 `bilibili` / `weibo` / `search.weibo`，
  `secrets.yaml` 的 `bilibili`）。
- 删除硬编码平台/通道注册表。
- 将内置平台相关搜索源迁出核心。
- 统一 `FetchPlugin` 为 `FetchProvider`。

**0.4.0 保留（deprecated），0.4.1 删除：**

- `asg plugins` 与 `PluginStatus`。
- `scripts/backends/`。
- `scripts/migrations/` 与 `0.3.x` 迁移步骤。
- `data/backends` 默认迁移读取（0.4.0 仅作为只读迁移源）。

> 升级顺序：0.3.11 → 跑迁移脚本 → 官方插件升到 0.2.x → 安装 0.4.0。

---

## 11. 开放项

1. ~~官方插件 v0.2.0 尚未发布，真实清单和 config 映射无法填。~~
   **已解决**：官方插件已发布（bilibili / cnki `0.2.0`，weibo `0.2.2`），迁移清单已填。
2. 迁移顺序已确定：0.3.11 → 迁移脚本 → 官方插件 0.2.x → 0.4.0。
3. 官方插件 manifest 必须遵守“backend 不跨 channel 共用”。
4. 平台无关清理范围大；0.4.0 已完成 V1/旧配置清理，剩余的过渡目录在 0.4.1 删除。
5. 0.4.0 要求升级前离线迁移，旧配置解析不再放宽。
