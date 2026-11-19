# 引擎 Provider 注册层

本文说明网关两类引擎的分工、`EngineProvider` 协议，以及新增一个网关原生引擎时需要改什么。

## 1. 两类引擎

| 类别 | 归属 | 谁执行 | 启用状态存哪里 |
|---|---|---|---|
| searxng 引擎 | `EngineGroup = "searxng"` | searxng 进程 | `data/deps/searxng/settings.yml` 的 `engines[].disabled` |
| 网关原生引擎 | `gateway.reverse_image` / `gateway.search` / `gateway.upstream` | gateway（Node） | 内置源写 `gateway.yaml` 的 `search.*`；扩展源写 `extensions.<id>.config` |

- **searxng 引擎**由 searxng 自己执行；网关只负责改 settings.yml，然后把引擎名转发给 searxng。
- **网关原生引擎**由 gateway 自己执行。provider 同时提供 CLI 需要的元数据（名称、可用性、routing、requires）和运行期需要的调用实现。
- **通用上游**（`gateway.upstream`）是网关原生引擎中的特殊一类：不按类别路由，只在 general 查询与 searxng 并发，产出候选后交给跨源融合（ADR-0023）。

CLI 与运行期共享 `src/engines/types.ts` 里的 `EngineKind` / `EngineGroup` / `EngineRecord`；`src/cli/engines/types.ts` 只是重新导出这些公共类型，并保留 CLI 专属的 `EngineStore` 契约。

## 2. EngineProvider 协议

定义在 `src/engines/provider.ts`：

```ts
interface EngineProvider {
  id: string;              // `${group}:${name}`
  group: EngineGroup;
  name: string;
  kind: EngineKind;
  displayName: string;     // 面向用户/错误文案
  routing(ctx): string[];
  requires?: string[];     // secrets.… / secret:<name> / config:…
  available(ctx): boolean; // 前置条件（密钥 / 上游能力开关）
  enabled?(ctx): boolean;  // 引擎自身的启用状态
  enabledPath?: string[];  // gateway.search / gateway.upstream 写回 gateway.yaml 的布尔路径
  runtime?: EngineRuntime;
  authHint?: string;
}
```

`EngineProviderContext` 是 provider 唯一的输入：

```ts
{
  config: Record<string, unknown>;   // 与 gateway.yaml 同形的切片（内置实现使用）
  secrets: Record<string, unknown>;  // 与 secrets.yaml 同形的切片（内置实现使用）
  pluginConfig?: Readonly<Record<string, unknown>>; // 第三方 search 插件私有配置
  pluginSecrets?: Record<string, string>; // 第三方 search 插件密钥（已解析）
  logger?: Logger;
}
```

- CLI 传原始 `configPlain`（整份 gateway.yaml）与 secrets。
- 运行期传 `{ search, weibo }` 与 `{ search: { reverse_image: { saucenao: { api_key } }, deepseek: { api_key } } }`。
- provider 内部一律用 `asObject` / `dig` 读取，不依赖完整 schema 类型，因此两种调用方可以共用。
- 第三方 search 插件读取 `ctx.pluginConfig`：来源是 `gateway.yaml` 的
  `extensions.<manifest id>.config`，已按 manifest 的 `config_schema` 校验并补齐默认值，递归冻结。
- 第三方 search 插件读取 `ctx.pluginSecrets`：来源是 `secrets.yaml` 的
  `extensions.<manifest id>.<name>`，兼容旧的 `extensions.<engineId>.<name>`
  （manifest id 优先），`env:NAME` 已解析，空值不注入。

`requires` 支持三种依赖：

- `secrets.a.b`：内置密钥，读 `secrets.yaml` 的 `a.b`；
- `secret:<name>`：扩展密钥，优先读 `secrets.yaml` 的
  `extensions.<manifest id>.<name>`，并继续兼容旧的 `extensions.<engineId>.<name>`；
  运行期两者都会合并进 `ctx.pluginSecrets`，值为空（含解析后的 `env:` 为空）时
  `available()` 强制返回 false。
  注意：`asg engines enable` 的依赖检查同样先查
  `extensions.<manifest id>.<name>`，解析后为空（含 `env:` 为空）再回退
  `extensions.<engineId>.<name>`；两者任一非空即满足。
- `config:a.b`：配置依赖，读 `gateway.yaml`。

运行期分三种：

- `ReverseImageRuntime`：`kind: "reverse_image"`，`search(input, ctx)` 返回统一的 `SourceCall`。
- `GatewaySearchRuntime`：`kind: "search"`，`plan(categories, ctx)` 判断类别是否命中，`search(query, options, ctx)` 返回 `GatewaySearchResult`。
- `GatewayUpstreamRuntime`：`kind: "upstream"`，`search(query, options, ctx)` 返回 `GatewaySearchResult`；没有 `plan()`，参与条件由运行期统一判断（见 3.2）。

## 3. 新增一个网关原生引擎

以新增「example 反查源」为例：

1. **同步源清单**（仅以图搜图源需要）
   - 在 `src/settings/gateway-sources.ts` 的 `GATEWAY_SOURCES` 与 `GATEWAY_SOURCE_SPECS` 加名字；
   - `settings/schema.ts` 的 `reverse_image.sources` 枚举会自动接受它。
2. **新建 provider 文件**
   - 路径：`src/engines/providers/example.ts`；
   - 导出 `exampleProvider: EngineProvider`，实现 `id/group/name/kind/displayName/routing/available` 与 `runtime`；
   - 配置读取走 `ctx.config.search.reverse_image...`，密钥读取走 `ctx.secrets...`。
3. **注册**
   - 在 `src/engines/registry.ts` 的 `ENGINE_PROVIDERS` 数组加一行 `exampleProvider`；
   - 模块加载时会检查 id 唯一，重复直接抛错。

不需要改 CLI 命令、`GatewayStore` 或 `service.ts`。CLI 的 `asg engines list` 会通过 `providersForGroup("gateway.reverse_image")` 自动出现该源，运行期也会按 `search.reverse_image.sources` 自动分发。

文本源（`gateway.search`）同理：新建 provider、在 registry 注册，并声明 `enabled(ctx)` 与 `enabledPath`（扩展源如 `["extensions","weibo","config","enabled"]`）。CLI 的 `GatewayStore` 会按 `enabledPath` 自动读写，运行期按 `providersForGroup("gateway.search")` 依次询问 `enabled()` / `plan()`，不需要再改 store 或 `service.ts`。**内置 provider** 如果带独立配置段，仍需在 `settings/schema.ts` 增加对应 schema；复用现有配置段则不必。第三方扩展不需要改核心 schema：用 manifest 的 `config_schema` 声明私有配置（见 3.1）。

### 3.1 第三方扩展的路由、私有配置与密钥

`src/extensions/loader.ts` 加载 `provides: ["search"]` 的扩展时，`extensions` 段里有两类键：

```yaml
extensions:
  weibo:                      # manifest id：私有配置（config）
    config:
      enabled: true
      limit: 20
  "gateway.search:weibo":     # engineId：路由覆盖（routing）
    routing:
      category: news
      hot_category: news_hot
```

- `routing` 按 **engineId** 读取，只对 `group: "gateway.search"` 的文本源生效；
  图搜源的 `routing()` 固定为 `source`，不会被覆盖。
- `config` 按 **manifest id** 读取，交给 manifest 的 `config_schema` 校验并补默认值，
  再以 `ctx.pluginConfig` 注入插件的 `routing()` / `available()` / `enabled()` / `runtime`。
  配置未声明 schema 时原样透传；空对象不注入。
- `secrets` 同时认 manifest id 与 engineId，manifest id 优先（见第 2 节 `secret:<name>`）。

有 `routing.category` / `routing.hot_category` 时，loader 包装 provider：

- `routing()` 返回已设置的 `category:<值>`（不再调用插件自身的 `routing()`）；
- `runtime.kind === "search"` 时由宿主生成的 `plan()` 覆盖插件 plan，优先级为
  **hot 命中 → `{ hot: true }`，普通类别命中 → `{ hot: false }`，都不中 → `undefined`**；
- 类别匹配大小写不敏感、按逗号分隔，与插件 SDK 的 `hasCategory` 一致。

插件可以把 `enabledPath` 指向自己的私有配置，让 `asg engines enable/disable` 直接写回
`gateway.yaml`（`GatewayStore` 只按路径写布尔值，不关心它属于哪个段）：

```ts
enabledPath: ["extensions", "example", "config", "enabled"],
enabled: (ctx) => ctx.pluginConfig?.enabled !== false,
```

对应 `config_schema` 里声明 `enabled: { "type": "boolean", "default": true }`，
用户也可以直接用 `asg extensions config example --set enabled=false` 修改同一个开关。

`--clear` 会删除 `extensions.<engineId>.routing`，插件恢复自己的默认 `routing()` 与 `plan()`。
没有路由 / 配置 / 密钥的插件不会被包装，行为与插件自身实现完全一致。

### 3.2 通用上游（`gateway.upstream`）

通用上游与文本源的区别：**不按类别路由、不经过 searxng、与 searxng 并发**，只在
general 查询参与。当前内置 `gateway.upstream:deepseek`（ADR-0023）。

```ts
interface GatewayUpstreamOptions {
  limit: number;
  minScore?: number;
  language?: string;
  safeSearch?: string;
}

interface GatewayUpstreamRuntime {
  kind: "upstream";
  search(
    query: string,
    options: GatewayUpstreamOptions,
    ctx: EngineProviderContext,
  ): Promise<GatewaySearchResult>;
}
```

参与条件（全部满足才调用）：

1. `enabled(ctx) === true`；
2. `available(ctx) === true`（密钥解析后非空）；
3. 不是反向图搜；
4. `query.trim() !== ""`；
5. `categories` 为空，或规范化后只包含 `general`；
6. 没有显式 `engines`。

provider 的 `available()` 必须先用 `resolveSecretValue` 解析 `env:` 再判空（CLI 传入的
可能是 `env:DEEPSEEK_API_KEY` 原文）；`enabled()` 严格要求
`search.deepseek.enabled === true`，缺省为 false。

`minScore` 由 provider 在**源内**处理：raw 按 `rerank_score / 3 >= minScore` 过滤，
harness 忽略它；服务层不再对上游结果做全局 `minScore` 过滤。空结果返回
`ok: true, results: []`；调用失败返回 `ok: false`，由服务层静默降级并追加说明。

融合规则：

- 每个源清洗后做**源内名次归一化**：第 1 名 `1.0`，第 2 名 `(n - 1) / n`，最后一名 `1 / n`；
- 按规范化 URL 去重合并：`engines` 取并集，`content` / `title` /
  `publishedDate` 空则补齐，`score` 取较大值；
- 最终按 `score × engine_boost` 稳定降序；`engine_boost` 先看 `engines`，再看
  `engine`。多上游分支不再调用 `rerankResults`，避免二次 boost；
- raw 的官方 `rerank_score` 只用于源内排序与源内 `min_score`；harness 没有原始分，
  不参与 `min_score`，但同样通过名次归一化获得跨源可比的分数；
- 失败只影响该源：结果末尾追加提示；只有 searxng 与所有通用上游都失败才报错；
- 启用但不可用（如未配 key）或任一源失败时，本次结果**不写缓存**；
- `SearchMetrics.generalUpstreams` 记录每个通用上游的 `id / ok / results / ms /
  error`（仅多上游分支填充）。

CLI 支持 `asg engines list/enable/disable/secret`；`route` 不支持通用上游，报
`ENGINE_NO_ROUTING`。v1 **不向第三方插件开放**该组，只允许内置 provider。

新增内置通用上游需要：provider 文件、`registry.ts` 注册行、`settings/schema.ts` 的
配置段与 `settings/secrets.ts` 的密钥段；运行期参与条件与融合逻辑由服务层统一处理。

## 4. CLI 与运行期如何消费

### CLI

`src/cli/engines/stores/gateway.ts`：

- 遍历 `providersForGroup("gateway.reverse_image")` 生成记录：`id/name/kind` 直接取 provider，`enabled` 由 `search.reverse_image.sources` 决定，`available/routing/requires` 调 provider；
- 遍历 `providersForGroup("gateway.search")` 生成记录，`enabled` / `available` / `routing` / `requires` 全部来自 provider（含 loader 施加的 `extensions` 覆盖）；
- 遍历 `providersForGroup("gateway.upstream")` 生成记录，`enabled` 按 provider 的 `enabledPath`（如 `search.deepseek.enabled`）读取；该组不支持 `route`；
- **写入仍由 store 负责**：reverse_image 增删 `sources` 数组；文本源与通用上游按 provider 的 `enabledPath` 写布尔值。provider 不碰 YAML。

### 运行期

`src/search/service.ts`：

- 反向图搜：遍历 `search.reverse_image.sources`，用 `engineProvider("gateway.reverse_image", name)` 找 provider；未知源或 `available() === false` 直接跳过；`runtime.search(imageInput, ctx)` 与 searxng 并发。
- 文本源：在请求 searxng 之前遍历 `providersForGroup("gateway.search")`，`available()` + `enabled()` + `runtime.plan(params.categories)` 命中即调用 `runtime.search()`，完全不经过 searxng。
- 通用上游：遍历 `providersForGroup("gateway.upstream")`，按 3.2 的条件筛选后与 searxng 批次**并发**；成功结果先清洗、再做源内名次归一化，最后与 searxng 结果按 URL 合并并按 `score × engine_boost` 排序。失败只追加提示，不阻断 searxng。

## 5. 注册边界

当前是**编译期静态注册**：

- `registry.ts` 直接 import 内置 provider，构建时全部打包；
- id 重复属于编程错误，模块加载即 throw；
- 内置 provider 没有动态发现；第三方扩展通过 `data/extensions` 加载 search 引擎（见 `docs/extensions.md`），再以 overlay 形式合并进注册表。

`extensions.<engineId>.routing` 只覆盖路由/类别判断，不改变 provider 的启用状态；启用/禁用
仍由 `asg engines enable/disable` 按 provider 的 `enabledPath` 写入（内置源写 `search.*`，
扩展源可以指向 `extensions.<id>.config.enabled`）。

当前已知边界：

- `service.ts` 的文本源 `limit` 取请求值与 `search.max_results_cap`，不再有平台独立上限；新增需要独立上限的文本源时，要扩展 `GatewaySearchPlan` / `GatewaySearchOptions`。
- 新文本源如果带独立配置段，**内置 provider** 仍需同步 `settings/schema.ts`；
  第三方扩展改用 manifest 的 `config_schema` + `extensions.<id>.config`，不再改核心 schema。
- 通用上游（`gateway.upstream`）v1 只内置：`extensions/loader.ts` 不把该组加入第三方
  allowlist；新增内置源需同时改 `settings/schema.ts` 与 `settings/secrets.ts`。
- 以图搜图源仍需同步 `GATEWAY_SOURCES` / `GATEWAY_SOURCE_SPECS`，schema 枚举才能接受新名字。
