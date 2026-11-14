# 引擎 Provider 注册层

本文说明网关两类引擎的分工、`EngineProvider` 协议，以及新增一个网关原生引擎时需要改什么。

## 1. 两类引擎

| 类别 | 归属 | 谁执行 | 启用状态存哪里 |
|---|---|---|---|
| searxng 引擎 | `EngineGroup = "searxng"` | searxng 进程 | `data/deps/searxng/settings.yml` 的 `engines[].disabled` |
| 网关原生引擎 | `gateway.reverse_image` / `gateway.search` | gateway（Node） | `gateway.yaml`：`search.reverse_image.sources` / `search.weibo.enabled` |

- **searxng 引擎**由 searxng 自己执行；网关只负责改 settings.yml，然后把引擎名转发给 searxng。
- **网关原生引擎**由 gateway 自己执行。provider 同时提供 CLI 需要的元数据（名称、可用性、routing、requires）和运行期需要的调用实现。

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
  requires?: string[];     // secrets.… / config:…
  available(ctx): boolean; // 前置条件（密钥 / 上游能力开关）
  enabled?(ctx): boolean;  // 引擎自身的启用状态
  enabledPath?: string[];  // gateway.search 写回 gateway.yaml 的布尔路径
  runtime?: EngineRuntime;
  authHint?: string;
}
```

`EngineProviderContext` 是 provider 唯一的输入：

```ts
{
  config: Record<string, unknown>;   // 与 gateway.yaml 同形的切片
  secrets: Record<string, unknown>;  // 与 secrets.yaml 同形的切片
  logger?: Logger;
}
```

- CLI 传原始 `configPlain`（整份 gateway.yaml）与 secrets。
- 运行期传 `{ search, weibo }` 与 `{ search: { reverse_image: { saucenao: { api_key } } } }`。
- provider 内部一律用 `asObject` / `dig` 读取，不依赖完整 schema 类型，因此两种调用方可以共用。

运行期分两种：

- `ReverseImageRuntime`：`kind: "reverse_image"`，`search(input, ctx)` 返回统一的 `SourceCall`。
- `GatewaySearchRuntime`：`kind: "search"`，`plan(categories, ctx)` 判断类别是否命中，`search(query, options, ctx)` 返回 `GatewaySearchResult`。

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

文本源（`gateway.search`）同理：新建 provider、在 registry 注册，并声明 `enabled(ctx)` 与 `enabledPath`（如 weibo 的 `["search","weibo","enabled"]`）。CLI 的 `GatewayStore` 会按 `enabledPath` 自动读写，运行期按 `providersForGroup("gateway.search")` 依次询问 `enabled()` / `plan()`，不需要再改 store 或 `service.ts`。新文本源如果带独立配置段，仍需在 `settings/schema.ts` 增加对应 schema；复用现有配置段则不必。

## 4. CLI 与运行期如何消费

### CLI

`src/cli/engines/stores/gateway.ts`：

- 遍历 `providersForGroup("gateway.reverse_image")` 生成记录：`id/name/kind` 直接取 provider，`enabled` 由 `search.reverse_image.sources` 决定，`available/routing/requires` 调 provider；
- 遍历 `providersForGroup("gateway.search")` 生成记录，`enabled` / `available` / `routing` / `requires` 全部来自 provider；
- **写入仍由 store 负责**：reverse_image 增删 `sources` 数组；文本源按 provider 的 `enabledPath` 写布尔值。provider 不碰 YAML。

### 运行期

`src/search/service.ts`：

- 反向图搜：遍历 `search.reverse_image.sources`，用 `engineProvider("gateway.reverse_image", name)` 找 provider；未知源或 `available() === false` 直接跳过；`runtime.search(imageInput, ctx)` 与 searxng 并发。
- 文本源：在请求 searxng 之前遍历 `providersForGroup("gateway.search")`，`available()` + `enabled()` + `runtime.plan(params.categories)` 命中即调用 `runtime.search()`，完全不经过 searxng。

## 5. 注册边界

当前是**编译期静态注册**：

- `registry.ts` 直接 import 内置 provider，构建时全部打包；
- id 重复属于编程错误，模块加载即 throw；
- 没有动态发现、没有外部插件加载。

后续若支持外部 provider，需要另行定义 manifest / 加载目录 / 沙箱边界；在此之前，新增引擎必须改源码并重新发版。

当前已知边界：

- `service.ts` 的文本源 `limit` 仍取 `search.weibo.limit`；新增需要独立上限的文本源时，要扩展 `GatewaySearchPlan` / `GatewaySearchOptions`。
- 新文本源如果带独立配置段，仍需同步 `settings/schema.ts`。
- 以图搜图源仍需同步 `GATEWAY_SOURCES` / `GATEWAY_SOURCE_SPECS`，schema 枚举才能接受新名字。
