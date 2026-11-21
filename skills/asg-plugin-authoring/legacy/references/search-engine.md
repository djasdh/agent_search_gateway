# engine（搜索源 / 图搜源）契约

`provides` 含 `"search"` 时，`entry` 必须导出命名 `engine`，形状为 `EngineProvider`：

```ts
export interface EngineProvider {
  id: string;                       // `${group}:${name}`
  group: "searxng" | "gateway.reverse_image" | "gateway.search"; // 第三方插件可用组
  name: string;
  kind: "searxng" | "gateway";      // 第三方插件固定 "gateway"
  displayName: string;
  routing(ctx: EngineProviderContext): string[];
  requires?: string[];
  available(ctx: EngineProviderContext): boolean;
  enabled?(ctx: EngineProviderContext): boolean;
  enabledPath?: readonly string[];
  runtime?: EngineRuntime;
  authHint?: string;
}
```

## EngineProviderContext

```ts
export interface EngineProviderContext {
  config: Record<string, unknown>;        // 核心内置实现使用
  secrets: Record<string, unknown>;       // 核心内置实现使用
  pluginConfig?: Readonly<Record<string, unknown>>; // 插件私有配置（已补默认值、冻结）
  pluginSecrets?: Record<string, string>;           // 插件密钥（已解析，空值不注入）
  pluginBackends?: PluginBackends;                  // V2 声明 backends 时注入
  logger?: Logger;
}
```

第三方插件只读 `ctx.pluginConfig` / `ctx.pluginSecrets` / `ctx.pluginBackends`。`config` / `secrets` 是宿主给
核心内置 provider 的切片（运行期只有 `{ search, weibo }` 等），不是稳定契约。

`pluginConfig` 来自 `gateway.yaml → extensions.<manifest id>.config`，由 manifest 的
`config_schema` 校验并补齐默认值；声明了 schema 时没有用户配置也会收到默认值对象。
`pluginSecrets` 来自 `secrets.yaml → extensions.<manifest id>.<name>`，兼容旧的
`extensions.<engineId>.<name>`（manifest id 优先）。

## 通用上游：`gateway.upstream`（v1 仅内置）

`gateway.upstream` 是网关直接调用、与 searxng 并发的通用搜索出口（当前内置
`gateway.upstream:deepseek`，见 ADR-0023）。它只在 general 查询参与，不按类别路由，
结果由网关按源内名次归一化后融合。

**v1 不向第三方插件开放**：`extensions/loader.ts` 不把该组加入 allowlist，manifest 声明
`provides: ["search"]` 也不会加载它。第三方插件只能使用 `gateway.search`（文本源）与
`gateway.reverse_image`（图搜源）。

## 文本源：`gateway.search`

```ts
runtime: {
  kind: "search",
  plan(categories: string | undefined, ctx): { hot: boolean } | undefined,
  search(query: string, options: { hot: boolean; limit: number }, ctx): Promise<GatewaySearchResult>,
}
```

- `routing` 返回类别名列表：`["category:weibo", "category:weibo_hot"]`；
- 用户可以用 `asg engines route <engine> --category <name> [--hot-category <name>]` 覆盖
  `routing` / `plan`（宿主合成的 plan 优先 hot，再普通类别）；`--clear` 恢复插件默认；
- `plan` 只在类别命中时返回计划；不命中返回 `undefined`（宿主继续其它引擎）；
- `categories` 是逗号分隔字符串，大小写不敏感，用 `hasCategory(categories, name)` 判断；
- `hot: true` 表示热榜/热搜类查询，不需要关键词，`query` 可能为空；
- 返回结构：

```ts
type GatewaySearchResult =
  | { ok: true; results: SearxngResult[]; latencyMs: number }
  | { ok: false; error: { kind: "timeout" | "network" | "api" | "auth" | "invalid"; message: string }; latencyMs: number };
```

- `SearxngResult` 至少要有 `url` / `title`，建议填 `content` / `engine` / `score`；
- “没有结果”与“调用失败”要区分：空结果返回 `ok: true, results: []`，上游错误才 `ok: false`；
- 搜索页/浏览器型上游常有异步加载，建议空结果重试 + 短 TTL 缓存 + 并发限制。

## 图搜源：`gateway.reverse_image`

```ts
runtime: {
  kind: "reverse_image",
  search(input: ImageInput, ctx): Promise<SourceCall>,
}
```

```ts
type ImageInput =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Uint8Array; filename: string; mime: string };

type SourceCall =
  | { ok: true; results: SearxngResult[]; latencyMs: number; /* quota? remaining? */ }
  | { ok: false; error: { kind: "timeout" | "http" | "network" | "invalid_json" | "api"; status?: number; message: string } };
```

- `kind: "url"` 时直接请求图片 URL；`kind: "bytes"` 时用 multipart 上传；
- 返回候选结果，由宿主合并去重；
- 配额/限流信息可放在成功结果的附加字段里（如 `quota`、`remaining`）。

## enabled / available / enabledPath

- `available(ctx)`：密钥、上游开关等前置条件；**不包含**引擎自己的 enabled；
- `enabled(ctx)`：引擎自身开关，读 `ctx.pluginConfig?.enabled !== false`；
- `enabledPath`：该布尔值在 `gateway.yaml` 中的路径；扩展插件用
  `["extensions", "<manifest id>", "config", "enabled"]`，这样 `asg engines enable/disable`
  会写回插件自己的 config 段，与 `asg extensions config <id> --set enabled=...` 等价；
- `requires`：人类可读的前置条件。`secret:<name>` 表示扩展密钥，运行期读
  `ctx.pluginSecrets[<name>]`；新键是
  `secrets.yaml → extensions.<manifest id>.<name>`，旧的
  `extensions.<engineId>.<name>` 继续兼容。
  - 写新键：`asg extensions secret <manifest id> --name <name> --stdin`；
  - 写旧键：`asg engines secret <engine> --name <name> --stdin`；
  - 注意 `asg engines enable` 的依赖检查同样先查新键
    （`extensions.<manifest id>.<name>`），解析后为空再回退旧 engineId 键；
    两者任一非空即满足。

## 示例

见 `../../examples/search-engine.ts`（文本源）。要点：

```ts
const conf = (ctx) => ctx.pluginConfig ?? {};

routing: (ctx) => [`category:${String(conf(ctx).category ?? "example")}`],
available: () => true,  // 密钥/上游开关等前置条件；不包含 enabled
enabled: (ctx) => conf(ctx).enabled !== false,
enabledPath: ["extensions", "example", "config", "enabled"],
runtime: {
  kind: "search",
  plan: (categories, ctx) => hasCategory(categories, String(conf(ctx).hot_category ?? "example_hot"))
    ? { hot: true }
    : undefined,
  search: async (query, { limit }, ctx) => ({ ok: true, results: await run(query, limit), latencyMs: 0 }),
}
```

manifest 里对应声明：

```json
{
  "id": "example",
  "config_schema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true, "description": "总开关" },
      "base_url": { "type": "string", "default": "https://api.example.com", "description": "上游根地址" },
      "category": { "type": "string", "default": "example", "description": "普通类别名" },
      "hot_category": { "type": "string", "default": "example_hot", "description": "热搜类别名" },
      "timeout_ms": { "type": "integer", "default": 10000, "minimum": 1000, "description": "上游超时（毫秒）" }
    }
  }
}
```

## 调试建议

- 单测直接构造 `{ config: {}, secrets: {}, pluginConfig, pluginSecrets }`，覆盖：
  - `routing()` 的类别列表；
  - `plan()` 的命中/不命中；
  - `available()` / `enabled()` 的开关组合与默认值；
  - `search()` 的成功、空结果、错误映射（用假 CLI 或本地 HTTP 桩）。
- 不要把 `plan` 写成会发请求的实现：它只做类别判断。
