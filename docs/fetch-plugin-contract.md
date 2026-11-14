# 抓取插件契约

本文定义内置抓取插件（fetch plugin）与抓取通道（fetch channel）的统一契约：
平台 ID、`match` / `enabled` / `available` 语义、密钥引用、结果 helper，以及通道层与
`asg plugins` 的元数据对应关系。

## 平台规范

平台 ID 使用小写英文规范名；中文与旧写法只作为输入别名，所有输出统一用规范 ID。

| 规范 ID | 显示名 | 别名 | 能力（capabilities） |
| --- | --- | --- | --- |
| `bilibili` | Bilibili | `bili`、`B站`、`哔哩哔哩` | `video`、`article`、`comments` |
| `weibo` | 微博 | `微博` | `post`、`comments`、`user`、`user-posts`、`image` |
| `cnki` | 知网 | `知网` | `pdf` |

代码入口：`src/fetch/platforms.ts`

```ts
normalizePlatform("bili");                 // "bilibili"
normalizePlatform("微博");                  // "weibo"
normalizePlatform("知网");                  // "cnki"
normalizePlatform("unknown");              // undefined
canonicalChannelId("bilibili", "kukemc");  // "bilibili:kukemc"
```

规则：

- `trim` + `toLowerCase` 后**精确匹配**，不做模糊纠错。
- 未知输入返回 `undefined`，由调用方报错或回退。
- 通道 ID 统一为 `platform:channel`，后续通道层直接复用。

## 平台与通道

平台对象负责 URL 匹配与取件编排；通道对象描述具体后端（CLI / HTTP / 会话）。
一个平台可以有多个通道：

| 平台 | 通道 ID | 通道名 | 类型 | 能力 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `bilibili` | `bilibili:kukemc` | kukemc | `cli` | detail、comments | `bili`、`cli-kukemc` |
| `bilibili` | `bilibili:ytdlp` | yt-dlp | `cli` | detail、audio | `ytdlp`、`cli-ytdlp` |
| `bilibili` | `bilibili:article` | article | `http` | detail、comments、audio、article | `article`、`bilibili:http` |
| `weibo` | `weibo:opencli` | OpenCLI | `cli` | post、comments、user、user-posts、image | `opencli`、`weibo` |
| `cnki` | `cnki:http` | CNKI HTTP | `http` | pdf | `cnki` |

代码入口：`src/fetch/channels/`

```ts
normalizeChannel("bili");            // bilibili:kukemc
normalizeChannel("bilibili:ytdlp");  // bilibili:ytdlp
normalizeChannel("opencli");         // weibo:opencli
normalizeChannel("cnki");            // cnki:http
```

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

### 插件声明通道

```ts
export const bilibiliPlugin: FetchPlugin = {
  id: "bilibili",
  // ...
  channels: [BILIBILI_KUKEMC, BILIBILI_YTDLP, BILIBILI_ARTICLE],
};
```

`channels` 是维护面/后续通道层的元数据，不参与 `find`。

### `asg plugins` 的 NAME 与通道

`asg plugins` 的 `NAME` 是**安装名**（`bili` / `ytdlp` / `opencli` / `article`）；
表格里的 `PLATFORM` 是平台 ID，`CHANNEL` 是完整通道 ID。JSON 同时给出
`channel`（通道名）与 `channel_id`（完整 ID）：

| 安装名 NAME | PLATFORM | CHANNEL（完整 ID） | channel |
| --- | --- | --- | --- |
| `bili` | `bilibili` | `bilibili:kukemc` | `kukemc` |
| `ytdlp` | `bilibili` | `bilibili:ytdlp` | `ytdlp` |
| `article` | `bilibili` | `bilibili:article` | `article` |
| `opencli` | `weibo` | `weibo:opencli` | `opencli` |

`install` / `remove` 同时接受旧安装名、规范通道 ID 与通道别名；输出与 JSON
始终使用规范 ID / 安装名。`cnki:http` 是内置平台，不是可安装插件。

## 插件契约

```ts
interface FetchPlugin {
  id: string;                 // 规范平台 ID
  platform: string;           // 与 id 相同
  name: string;               // 兼容旧日志/结果标注
  displayName: string;
  aliases?: readonly string[];
  settingsKey?: string;       // 对应设置段，如 "bilibili"
  capabilities: readonly string[];
  requires?: readonly FetchPluginRequirement[];
  channels?: readonly FetchChannel[];

  match(url: URL): boolean;
  enabled?(ctx: FetchPluginContext): boolean;
  available?(ctx: FetchPluginContext): boolean;
  fetch(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult>;
}
```

三个方法的分工：

| 方法 | 语义 | 是否参与 `find` |
| --- | --- | --- |
| `match(url)` | 纯 URL 判断是否由该插件接管；不读配置、不抛错 | 是 |
| `enabled(ctx)` | 统一开关（如 `bilibili.enabled`）；返回 false 即跳过并回退通用抓取 | 是 |
| `available(ctx)` | 维护面可用性（健康检查 / 列表 / 后续 `asg plugins`） | **否** |

注册表 `find` 的顺序固定为：`enabled` → `match`，任一抛错都视为不接管，
不会影响后续插件，也不会影响通用抓取路径。

```ts
const plugin = fetchPluginRegistry.find(url, ctx);
if (plugin) return await fetchViaPlugin(plugin, url, ctx);
// 否则继续 SSRF 校验 + 通用抓取
```

## 密钥：`env:` 引用

`secrets.yaml` 里的字符串支持 `env:NAME`：

```yaml
bilibili:
  http:
    token: env:BILIBILI_HTTP_TOKEN
```

- 只支持 `env:NAME`；`env:` 前后允许空白。
- 环境变量缺失时解析为空串（等同未配置，不报错）。
- 非 `env:` 的值原样返回，作为兼容保留。
- **推荐**：生产环境用环境变量注入密钥，不建议长期把明文密钥写在本程序的
  `secrets.yaml` 里。

加载时先 `resolveSecretTree` 解析引用，再执行原有的 `applySecretEnv`
（`BILIBILI_HTTP_TOKEN` 等固定环境变量仍可覆盖）。

插件读取密钥统一走 `ctx.getSecret(path)`，路径支持带或不带 `secrets.` 前缀：

```ts
ctx.getSecret("secrets.bilibili.http.token");
ctx.getSecret("bilibili.http.token");
```

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

`FetchPluginResult` 约定：

- 成功：`ok: true` + `bytes` 或 `html` 二选一；
- 失败：`ok: false` + `errorCode` / `errorMessage`，可选 `status`、`finalUrl`；
- 插件自管 headers / cookies / 会话 / 逐跳重定向，网关只看产物。

## 新增一个内置抓取插件

1. 在 `src/fetch/platforms.ts` 的 `PLATFORMS` 里登记规范 ID、显示名与别名。
2. 新建 `src/<platform>/index.ts`（或 `src/fetch/plugins/<id>.ts`），实现
   `FetchPlugin`：填写 `id` / `platform` / `name` / `displayName` /
   `capabilities` / `requires`，并实现 `match` 与 `fetch`。
3. `match` 只做纯 URL 判断；开关写到 `enabled(ctx)`；维护面信息写到
   `available(ctx)` 与 `requires`；在 `channels` 里声明该平台实际使用的通道。
4. 在 `src/fetch/plugins/index.ts` 的 `fetchPluginRegistry` 里按优先级注册；
   如通道是新后端，同时在 `src/fetch/channels/registry.ts` 登记。
5. 补测试：URL 匹配、`enabled` 禁用后 `find` 回退、结果字段与错误码。

注册表会在构造时检查重复 `id`，重复直接 `throw`，避免静默覆盖。

## 外部插件

`FetchPlugin` 与 `src/fetch/channels/` 目前只是**稳定契约**：第三方可以按这些接口
实现平台与通道，并单独测试。运行时的外部插件加载（目录约定、版本校验、沙箱/权限）
留到后续步骤，当前只有内置插件会被注册。
