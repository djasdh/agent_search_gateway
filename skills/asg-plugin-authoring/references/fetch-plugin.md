# fetch 插件契约

`src/index.ts` 导出命名 `fetch`，对象形状如下（与网关 `FetchPlugin` 一致）：

```ts
export interface FetchPlugin {
  id: string;
  platform: string;
  name: string;
  displayName: string;
  aliases?: readonly string[];
  capabilities: readonly string[];
  requires?: readonly FetchPluginRequirement[];
  channels?: readonly FetchChannel[];

  match(url: URL): boolean;                                   // 纯 URL 判断
  enabled?(ctx: FetchPluginContext): boolean;                 // 统一开关
  available?(ctx: FetchPluginContext): boolean;               // 维护面可用性
  fetch(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult>;
}
```

## match

- 只读 URL：不读配置、不发请求、**不抛错**；
- 只接管自己真正能处理的路径，避免误伤同域其它页面；
- 命中范围要稳定：不要因为 query 里出现某个参数就接管整站；
- 需要用户显式请求时，约定一个参数（如微博用 `?weibo=post`），否则回退通用抓取。

## enabled / available

- `enabled(ctx)`：统一开关。返回 `false` 时宿主跳过插件，回退通用抓取；
  读 `ctx.pluginConfig?.enabled !== false`（默认启用）。
- `available(ctx)`：只用于维护面（健康检查 / `asg` 列表），**不参与** URL 匹配。
  常用来检查命令是否存在、密钥是否配置（`ctx.pluginSecrets`）。
- 可选 `enabled` 表示始终启用。

不要在 `ctx.settings.<plugin>` 里读插件配置：那是核心内置实现的切片；外部插件的配置
由 manifest 的 `config_schema` 声明，存在 `gateway.yaml → extensions.<id>.config`。

## fetch 结果

```ts
export interface FetchPluginResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  bytes?: Buffer;         // 二进制或文本产物
  html?: string;          // 或 HTML（宿主会转 Markdown）；与 bytes 二选一
  errorCode?: string;
  errorMessage?: string;
}
```

约定：

- 文本用 `Buffer.from(text, "utf8")` + `contentType`（例如 `application/json`）；
- PDF/图片等直接返回 `bytes` + `contentType`；
- 失败时 `ok: false`，给出稳定 `errorCode`（例如 `NOT_SUBSCRIBED`、`NO_PDF`），
  `errorMessage` 面向 agent，尽量可操作；
- 需要提示操作时，在 `errorMessage` 末尾追加 `\n处理：<hint>`（与内置插件风格一致）。

## context

```ts
export interface FetchPluginContext {
  settings: FetchPluginSettings;      // 核心内置实现使用的 gateway.yaml 切片
  secrets: FetchPluginSecrets;        // 核心内置实现使用的 secrets.yaml 切片
  getSecret(path: string): string | undefined; // 内置实现使用
  logger?: Logger;                    // debug/info/warn/error，可缺省
  pluginConfig?: Readonly<Record<string, unknown>>; // 插件私有配置（已补默认值、冻结）
  pluginSecrets?: Record<string, string>;           // 插件密钥（已解析 env:）
  pluginBackends?: PluginBackends;                  // V2 声明 backends 时注入
}
```

- **外部插件只读 `pluginConfig` / `pluginSecrets` / `pluginBackends`**；`settings` / `secrets` / `getSecret()`
  是核心内置实现的切片，字段随核心变化，不保证稳定。
- `pluginConfig` 来自 `gateway.yaml → extensions.<manifest id>.config`；manifest 声明了
  `config_schema` 时一定注入（含默认值），否则只有非空 `config` 才注入，可能是 `undefined`。
- `pluginSecrets` 来自 `secrets.yaml → extensions.<manifest id>.<name>`，兼容旧的
  `extensions.<engineId>.<name>`（manifest id 优先）。`env:NAME` 已解析，空值不注入。
- `pluginBackends` 只在 V2 manifest 声明 `backends` 时存在：`dir(id)` 返回
  `data/extension-data/<id>/backends/<backend-id>`，`state(id)` 返回安装状态。
- `match(url)` 不注入配置，只能看 URL；开关与参数放在 `enabled` / `fetch` 里读。
- 字段名用 snake_case，与 `config_schema` 一致。

## 插件配置与密钥

manifest 示例：

```json
{
  "id": "example",
  "config_schema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true, "description": "总开关" },
      "timeout_ms": { "type": "integer", "default": 15000, "description": "请求超时（毫秒）" },
      "user_agent": { "type": "string", "description": "自定义 User-Agent" }
    }
  }
}
```

命令：

```bash
asg extensions config example
asg extensions config example --describe
asg extensions config example --set timeout_ms=20000
asg extensions config example --unset user_agent
asg extensions secret example --name cookie --stdin
```

- `extensions.<manifest id>.config` 是唯一配置来源；写前校验，失败不落盘；
- 成功后整栈重启；默认值不写回 `gateway.yaml`；
- 密钥不进 config，用 `asg extensions secret --stdin`（不回显）。

## 插件自行负责的事

网关**不**向插件传递 headers / cookies / 会话，也不干预重定向。因此：

- 自己设置 `User-Agent`、`Referer`、Cookie；
- 自己做逐跳重定向与登录态处理；
- 自己做大小上限（在 `config_schema` 里声明 `max_bytes` 之类）与超时（`timeout_ms`）；
- 自己限制目标域名（例如只允许 `*.cnki.net`），避免被摘要页里的外链带出站。

## 二进制与大文件

- 先看 `content-length`，超限直接 cancel 响应体；
- 流式累计字节，超过上限立即 `reader.cancel()`，不要把整个文件读进内存再判断；
- 用魔数判断真实类型（例如 `%PDF-`），不要只信 `Content-Type`。

## match 与 enabled 的区别

| 场景 | 用哪个 |
| --- | --- |
| “这个 URL 归不归我管” | `match` |
| “用户是否启用了这个平台” | `enabled` |
| “依赖是否装好 / 密钥是否配置” | `available` |

`enabled` 返回 false 后宿主会回退到通用抓取，因此不要在 `match` 里读开关。

## 实现建议

- `src/index.ts` 只做再导出，实现放 `src/plugin.ts`（避免 `export const fetch` 遮蔽全局 `fetch`）；
- 需要 CLI 时复制 `runCliProcess` 到 `src/sdk/cli.ts`，永不 `shell: true`；
- 需要多后端路由时，把失败映射成稳定错误码，日志只写 debug；
- 把错误码/端点导出成变量，方便测试指向本地桩服务器；
- 配置读取集中到一个 `pluginConfig(ctx)` 函数并给默认值，避免每个分支各写一套。
