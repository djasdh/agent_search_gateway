# 抓取插件契约

本文定义内置抓取插件（fetch plugin）的统一契约：平台 ID、`match` / `enabled` / `available`
语义、密钥引用方式与结果 helper。它是「抓取插件抽象统一」的第一步，**不**包含
`FetchChannel` 通道层与 `asg plugins` 的平台/通道字段。

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
   `available(ctx)` 与 `requires`。
4. 在 `src/fetch/plugins/index.ts` 的 `fetchPluginRegistry` 里按优先级注册。
5. 补测试：URL 匹配、`enabled` 禁用后 `find` 回退、结果字段与错误码。

注册表会在构造时检查重复 `id`，重复直接 `throw`，避免静默覆盖。

## 外部插件

`FetchPlugin` 目前只是**稳定契约**：第三方可以按此接口实现并单独测试。
运行时的外部插件加载（目录约定、版本校验、沙箱/权限）留到后续步骤，
当前只有内置插件会被注册。
