# 抓取 Provider 契约（FetchProvider）

本文定义抓取插件（fetch provider）与抓取通道（fetch channel）的统一契约：
平台 ID、`match` / `enabled` / `available` 语义、密钥引用与结果 helper。

> 0.4.0 起只接受 V2 manifest（`asg-extension.json`，`api_version: 2`）；运行期类型
> 统一叫 `FetchProvider`（0.3.x 文档里的 `FetchPlugin` 已更名，字段语义不变）。
> 第三方插件只读 `ctx.pluginConfig` / `ctx.pluginSecrets` / `ctx.pluginBackends`，
> 不再有 V1 的 `ctx.settings` 外部契约。

## 平台与通道由扩展声明

核心不再维护平台/通道注册表。平台 ID、通道 ID、别名和能力都来自已安装扩展：

- V2 manifest 的 `fetch_channels[].id` 使用 `platform:channel`，platform 取第一段前缀；
- 入口可以导出 `channels`；不导出时 manifest 的 `fetch_channels` 只用于展示；
- 通道对象是静态元数据，不参与 `find`。

### 通道契约

```ts
interface FetchChannel {
  id: string;             // `${platform}:${channel}`
  platform: string;
  channel: string;
  displayName: string;
  kind: "cli" | "http" | "session";
  capabilities: readonly string[];
  aliases?: readonly string[];
  probe?(ctx: ChannelContext): Promise<ChannelProbe>;
  dispose?(): Promise<void>;
}
```

- `CliChannel` 额外提供 `command` 与 `run(args, opts)`；
- `HttpChannel` 额外提供 `request(input, init)`；
- 所有 CLI 通道共用 `runCliProcess(command, args, opts)`：`execFile`、永不
  `shell: true`、默认 `maxBuffer` 4MB、超时与 spawn 失败都收敛成 `CliResult`。
- 当前通道对象是**静态元数据**；运行时执行仍由插件内部的 router / CLI / HTTP
  实现完成（例如 Bilibili 仍按动作路由到 kukemc / yt-dlp / article）。

### Provider 声明通道

```ts
export const exampleProvider: FetchProvider = {
  id: "example-plugin",
  // ...
  channels: [
    {
      id: "example:cli",
      platform: "example",
      channel: "cli",
      displayName: "Example CLI",
      kind: "cli",
      capabilities: ["page"],
    },
  ],
};
```

`channels` 是维护面/通道层的元数据，不参与 `find`。

### `asg plugins` 的 NAME 与通道

`asg plugins` 仅作为兼容 facade，0.4.0 deprecated、0.4.1 删除：`NAME` 来自扩展 manifest
的 `backends[].aliases[0]` 或 `backend.id`；`PLATFORM` / `CHANNEL` 字段暂为空字符串。
通道信息以 `asg extensions list` 的 `CHANNELS` 为准。

## Provider 契约

```ts
interface FetchProvider {
  id: string;                 // 扩展 ID；由 manifest.id 覆盖
  platform?: string;          // 可选回退值；缺省从 fetch_channels 前缀派生
  name: string;               // 兼容旧日志/结果标注
  displayName: string;
  aliases?: readonly string[];
  capabilities: readonly string[];
  requires?: readonly FetchProviderRequirement[];
  channels?: readonly FetchChannel[];

  match(url: URL): boolean;
  enabled?(ctx: FetchProviderContext): boolean;
  available?(ctx: FetchProviderContext): boolean;
  fetch(url: URL, ctx: FetchProviderContext): Promise<FetchProviderResult>;
}
```

三个方法的分工：

| 方法 | 语义 | 是否参与 `find` |
| --- | --- | --- |
| `match(url)` | 纯 URL 判断是否由该插件接管；不读配置、不抛错 | 是 |
| `enabled(ctx)` | 统一开关（如 `ctx.pluginConfig?.enabled`）；返回 false 即跳过并回退通用抓取 | 是 |
| `available(ctx)` | 维护面可用性（健康检查 / 列表 / 后续 `asg plugins`） | **否** |

注册表 `find` 的顺序固定为：`enabled` → `match`，任一抛错都视为不接管，
不会影响后续插件，也不会影响通用抓取路径。

```ts
const provider = fetchProviderRegistry.find(url, ctx);
if (provider) return await fetchViaProvider(provider, url, ctx);
// 否则继续 SSRF 校验 + 通用抓取
```

### 上下文

```ts
interface FetchProviderContext extends ChannelContext {
  logger?: Logger;
  pluginConfig?: Readonly<Record<string, unknown>>; // 外部插件私有配置
  pluginSecrets?: Record<string, string>;           // 外部插件密钥
  pluginBackends?: PluginBackends;                  // V2 声明 backends 时注入
}
```

- 外部插件只读 `ctx.pluginConfig` / `ctx.pluginSecrets`；声明了 `backends` 时还可以读
  `ctx.pluginBackends`。三者都属于 V2 契约。
- `pluginConfig` 来自 `gateway.yaml → extensions.<manifest id>.config`，由 manifest 的
  `config_schema` 校验并补齐默认值，递归冻结。声明了 schema 时即使没有用户配置也会注入。
- `pluginSecrets` 来自 `secrets.yaml → extensions.<manifest id>.<name>`；`env:NAME` 已解析，
  空值不注入。
- `pluginBackends` 提供 `ids` / `dir(id)` / `state(id)`，只在 manifest 声明了非空
  `backends` 时存在。
- `match(url)` **不注入配置**：只能看 URL；只有 `enabled` / `available` / `fetch` 能读配置。
- 未声明 `config_schema` 且没有非空配置/密钥时，provider 不会被包装，
  `ctx.pluginConfig` / `ctx.pluginSecrets` 可能为 `undefined`，插件应自己给默认值。

```ts
export const exampleProvider: FetchProvider = {
  // ...
  enabled: (ctx) => ctx.pluginConfig?.enabled !== false,
  async fetch(url, ctx) {
    const timeoutMs = typeof ctx.pluginConfig?.timeout_ms === "number"
      ? ctx.pluginConfig.timeout_ms
      : 15000;
    // ...
  },
};
```

## 密钥：`env:` 引用

`secrets.yaml` 里的字符串支持 `env:NAME`：

```yaml
extensions:
  example-fetch:
    api_key: env:EXAMPLE_API_KEY
```

- 只支持 `env:NAME`；`env:` 前后允许空白。
- 环境变量缺失时解析为空串（等同未配置，不报错）。
- 非 `env:` 的值原样返回，作为兼容保留。
- **推荐**：生产环境用环境变量注入密钥，不建议长期把明文密钥写在本程序的
  `secrets.yaml` 里。

外部插件读 `ctx.pluginSecrets`：

```ts
const apiKey = ctx.pluginSecrets?.api_key; // 已解析 env:，未配置时 undefined
```

- 键是 `extensions.<manifest id>.<name>`。
- 用 `asg extensions secret <id> --name <name> --stdin` 写入（值只从 stdin 读，不回显）。
- `requires` 目前只作为维护面元数据，不参与 `find`；缺密钥时请在 `available()` 里自行判断
  （或直接让 `fetch()` 返回稳定错误码）。

## 结果 helper

插件用统一 helper 构造结果，避免各写一套字段：

```ts
textResult(body, contentType, finalUrl?);        // 文本（bytes）
htmlResult(html, finalUrl?);                     // HTML（交给 html2md）
bytesResult(bytes, contentType, finalUrl?);     // 二进制 / PDF
errorResult(code, message, { status?, finalUrl?, hint? });
```

`errorResult` 有 `hint` 时会把 `\n处理：<hint>` 追加到 `errorMessage`，
与现有微博插件的错误风格一致；`code` 会透传到 `fetch` 结果的错误码前缀。

`FetchProviderResult` 约定：

- 成功：`ok: true` + `bytes` 或 `html` 二选一；
- 失败：`ok: false` + `errorCode` / `errorMessage`，可选 `status`、`finalUrl`；
- 插件自管 headers / cookies / 会话 / 逐跳重定向，网关只看产物。

## 新增一个抓取 Provider

官方插件仓库：`djasdh/agent-search-gateway-plugin-{bilibili,weibo,cnki}`，
0.4.0 配套版本为 bilibili / cnki `0.2.0`、weibo `0.2.2`。
第三方插件按 `docs/extensions.md` 的 manifest 与单文件 ESM 约定发布，核心不再内置平台实现。

1. 不需要改核心平台表：V2 manifest 用 `fetch_channels[].id` 声明平台/通道，
   平台前缀由第一段派生。
2. 在插件仓库实现 `FetchProvider`：填写 `id` / `name` / `displayName` /
   `capabilities` / `requires`，并实现 `match` 与 `fetch`。
3. `match` 只做纯 URL 判断；开关与参数读 `ctx.pluginConfig`（如
   `enabled: (ctx) => ctx.pluginConfig?.enabled !== false`）；维护面信息写到
   `available(ctx)` 与 `requires`；在 `channels` 里声明该平台实际使用的通道。
4. 在 `asg-extension.json` 的 `config_schema` 里声明私有配置；用户用
   `asg extensions config <id> --set key=value` 修改，密钥用
   `asg extensions secret <id> --name <name> --stdin` 写入。**不再**需要改核心
   `settings/schema.ts`。platform 从 `fetch_channels[0].id` 前缀派生。
5. 插件入口导出命名 `fetch`，由 `asg extensions install` 安装到
   `data/extensions/<id>/`；网关启动时自动加载。声明 `backends` 时，运行时用
   `ctx.pluginBackends.dir(id)` 取后端目录。
6. 补测试：URL 匹配、`enabled` 禁用后 `find` 回退、配置默认值、结果字段与错误码。

注册表会在构造时检查重复 `id`，重复直接 `throw`，避免静默覆盖。

## 外部插件

`FetchProvider` 与 `src/fetch/channels/` 是稳定契约。运行时加载由
`src/extensions/loader.ts` 负责：扫描 `data/extensions/<id>/asg-extension.json`，按 V2
manifest 的 `provides` 读取命名导出 `fetch` / `engine`，再注入 fetch 注册表与 gateway
engine overlay。安装、校验与发布流程见 `docs/extensions.md`。

插件与网关同进程运行，没有沙箱；只安装可信来源。
