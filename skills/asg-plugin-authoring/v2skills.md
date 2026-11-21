# V2 插件开发指南

本文只讲 `api_version: 2`。V1 流程仍保留在 [`SKILL.md`](SKILL.md) 与
[`references/`](references/)，不要按本文删改 V1 文档。

## 0. 先看版本边界

| 网关版本 | V1 manifest | V2 manifest | 平台配置 |
| --- | --- | --- | --- |
| 0.3.9 | 加载 | 加载 | 旧 `bilibili` / `weibo` / `search.weibo` 仍兼容 |
| 0.4.x | 报错 | 唯一路径 | 旧平台配置删除，只能用 `extensions.<id>.*` |

V2 插件从 0.3.9 起就能运行。新插件直接按本文写；已有 V1 插件先保持
`SKILL.md` 的流程，再按第 9 节迁移。

---

## 1. 最小 V2 插件

目录：

```text
example-plugin/
├── asg-extension.json
├── index.mjs
├── package.json
└── src/
    ├── index.ts
    ├── fetch.ts
    ├── engine.ts
    └── setup.ts
```

`index.mjs` 是构建产物，只导出命名对象/函数：

```js
export const fetch = { ... };
export const engine = { ... };
export async function setup(ctx) { ... }
```

没有 `fetch` 能力就不要导出 `fetch`；没有搜索源就不要导出 `engine`。
`provides` 与实际导出一致即可。

---

## 2. manifest

完整示例：

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "0.2.0",
  "api_version": 2,
  "description": "示例 V2 插件",
  "provides": ["fetch", "search"],
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
    "additionalProperties": false,
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true,
        "description": "是否启用"
      },
      "timeout_ms": {
        "type": "number",
        "default": 15000,
        "description": "单次请求超时"
      }
    }
  }
}
```

规则：

- 文件名是 `asg-extension.json`；V1 的 `asg-plugin.json` 只用于兼容。
- `version` 必须等于 Release tag 去掉 `v`。
- `fetch_channels[].id` 必须是 `platform:channel`；同一个扩展用同一个 platform 前缀。
- `search_engines[].id` 只能是 `gateway.search:<name>` 或
  `gateway.reverse_image:<name>`。
- `backends[].id` / `aliases` 只描述身份，不写下载地址或版本。
- 本版本不做严格字段校验，未知字段会被忽略；但不要依赖这一点。

---

## 3. 运行期上下文

fetch 和 search 插件都会收到：

```ts
ctx.pluginConfig?: Readonly<Record<string, unknown>>;
ctx.pluginSecrets?: Record<string, string>;
ctx.pluginBackends?: PluginBackends;
```

`pluginBackends` 只在 manifest 声明了非空 `backends` 时存在：

```ts
interface PluginBackends {
  readonly ids: readonly string[];
  dir(id: string): string;
  state(id: string): PluginBackendState | undefined;
}

interface PluginBackendState {
  installed: boolean;
  enabled: boolean;
  version?: string;
  path?: string;
}
```

- `dir(id)` 始终返回 `data/extension-data/<扩展 id>/backends/<backend-id>`。
- `state(id)` 读取 `backends.json`，并结合目录是否存在判断 `installed`。
- 不要自己拼 `data/extension-data` 路径。
- 不要读 `ctx.settings` / `ctx.config`；它们是核心内置实现的历史切片，V2 插件不要依赖。

---

## 4. 实现 fetch

```js
export const fetch = {
  // 只判断 URL，不读配置，不抛业务错误。
  match(url) {
    return url.hostname === "example.com";
  },

  // 统一开关。
  enabled(ctx) {
    return ctx.pluginConfig?.enabled !== false;
  },

  // 维护面可用性；不参与 find。
  available(ctx) {
    return ctx.pluginBackends?.state("example-cli")?.installed === true;
  },

  async fetch(url, ctx) {
    const dir = ctx.pluginBackends.dir("example-cli");
    const timeout = Number(ctx.pluginConfig?.timeout_ms ?? 15000);

    // 用 dir 里的 CLI / 资源完成抓取。
    // 返回 { ok: true, bytes } 或 { ok: true, html }。
    return {
      ok: true,
      contentType: "text/html",
      bytes: Buffer.from(`<html><body>${dir}:${url.href}:${timeout}</body></html>`),
    };
  },

  // 可选：静态通道元数据；manifest 的 fetch_channels 只做展示与 platform 派生。
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

platform 派生优先级：

```text
入口 fetch.platform > manifest.fetch_channels[0].id 前缀 > manifest.id
```

V2 manifest 不写 `platform` 字段。

---

## 5. 实现 search

```js
export const engine = {
  id: "gateway.search:example",
  group: "gateway.search",
  name: "example",
  displayName: "Example Search",

  available(ctx) {
    return ctx.pluginConfig?.enabled !== false;
  },

  routing() {
    return ["category:example"];
  },

  runtime: {
    kind: "search",

    plan(categories) {
      return categories?.split(",").map((item) => item.trim()).includes("example")
        ? { hot: false }
        : undefined;
    },

    async search(query, options, ctx) {
      const timeout = Number(ctx.pluginConfig?.timeout_ms ?? 15000);

      // 返回 { ok: true, results, latencyMs } 或
      // { ok: false, error: { kind, message }, latencyMs }
      return {
        ok: true,
        latencyMs: 0,
        results: [
          {
            url: `https://example.com/search?q=${encodeURIComponent(query)}`,
            title: `Example: ${query}`,
            content: `timeout=${timeout}`,
            engine: "example",
            score: 1,
          },
        ],
      };
    },
  },
};
```

`manifest.search_engines[].name` 只用于补展示名；运行时仍以入口 `engine.id` 为准。

---

## 6. setup 安装后端

声明了 `backends` 就必须导出 `setup(ctx)`。setup 在独立子进程中跑：

```js
import path from "node:path";

export async function setup(ctx) {
  const backendId = "example-cli";
  const dir = ctx.paths.backendDir(backendId);

  if (ctx.action === "status") {
    return {
      installed: await ctx.exists(dir),
      path: dir,
    };
  }

  if (ctx.action === "uninstall") {
    await ctx.remove(dir, { recursive: true, force: true });
    await ctx.backendState.clear(backendId);
    return { installed: false };
  }

  // install / update
  await ctx.mkdir(dir, { recursive: true });
  const archive = path.join(dir, "example-cli.tar.gz");
  await ctx.download("https://example.com/example-cli.tar.gz", archive, {
    sha256: "<64 位 hex>",
  });
  await ctx.extract(archive, dir);
  await ctx.remove(archive, { force: true });

  await ctx.backendState.write(backendId, {
    installed: true,
    enabled: true,
    version: "1.0.0",
  });

  return { installed: true, version: "1.0.0" };
}
```

运行期用同一个 backend id：

```js
const dir = ctx.pluginBackends.dir("example-cli");
const state = ctx.pluginBackends.state("example-cli");
if (!state?.installed) {
  return { ok: false, errorMessage: "example-cli 未安装" };
}
```

注意：

- 多后端插件按 `ctx.backends` 循环，只处理本次选中的 backend id；单后端示例可以直接硬编码。
- `install` / `update` 都可能传 `install`，实现要幂等。
- setup 只写 `ctx.paths.backendDir(id)` / `ctx.paths.tempDir`。
- 旧 `data/backends` 只读；需要迁移时复制，不要移动或删除。
- 下载只允许 https；强烈建议同时给 `sha256`。
- `backendState.write` 不是必须，但建议写，否则 `state(id).enabled` 可能是 false。

---

## 7. 配置与密钥

私有配置：

```bash
asg extensions config example-plugin --set enabled=false
asg extensions config example-plugin --set timeout_ms=20000
```

写入位置：

```yaml
extensions:
  example-plugin:
    config:
      enabled: false
      timeout_ms: 20000
```

密钥：

```bash
asg extensions secret example-plugin --name token --stdin
```

```yaml
extensions:
  example-plugin:
    token: env:EXAMPLE_TOKEN
```

运行期读 `ctx.pluginConfig` / `ctx.pluginSecrets`。不要再把平台配置写进
`gateway.yaml` 顶层。

### 从旧平台配置迁移

0.3.9 的迁移脚本会把：

| 旧位置 | 新位置 |
| --- | --- |
| `gateway.yaml → bilibili` | `extensions.bilibili.config` |
| `gateway.yaml → weibo` | `extensions.weibo.config` |
| `gateway.yaml → search.weibo` | `extensions.weibo.config.search` |
| `secrets.yaml → bilibili.http.token` | `extensions.bilibili.token` |

插件只读 `pluginConfig` / `pluginSecrets`，不要读旧顶层段。

---

## 8. 构建与发布

`package.json` 建议：

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Release 至少三个资产：

```text
asg-extension.json
index.mjs
SHA256SUMS
```

```bash
npm ci
npm run build
sha256sum index.mjs asg-extension.json > SHA256SUMS
gh release create v0.2.0 index.mjs asg-extension.json SHA256SUMS
```

过渡期如果还要支持 0.3.8 及更早版本，Release 同时带 V1 manifest：

```text
asg-extension.json   V2
asg-plugin.json      V1
index.mjs
SHA256SUMS           覆盖两个 manifest 与 entry
```

0.3.9 安装器优先 V2；0.3.8 只认 V1。

---

## 9. 从 V1 迁到 V2

1. 新增 `asg-extension.json`，保留 `asg-plugin.json` 作为过渡。
2. `api_version` 改为 `2`。
3. 加 `fetch_channels`：id 用 `platform:channel`。
4. 有搜索源时加 `search_engines`：id 用 `gateway.search:<name>` /
   `gateway.reverse_image:<name>`。
5. 有后端时加 `backends`，并导出 `setup(ctx)`。
6. 运行期配置从 `ctx.settings` / `ctx.config` 改成 `ctx.pluginConfig`。
7. 密钥从旧顶层段改成 `ctx.pluginSecrets`。
8. 需要后端时用 `ctx.pluginBackends.dir/state`。
9. 真实安装一次：`asg extensions install <owner>/<repo>@<version>`。

V1 文档仍在 [`SKILL.md`](SKILL.md)，不要因为迁移删除它。

---

## 10. 检查清单

- [ ] `asg-extension.json` 的 `api_version` 是 `2`
- [ ] `version` 与 Release tag 一致
- [ ] `entry` 是单个 `.mjs` / `.js` 文件，不含路径
- [ ] `provides` 与入口导出一致
- [ ] `fetch_channels[].id` 是 `platform:channel`，platform 前缀一致
- [ ] `search_engines[].id` 是 `gateway.search:*` / `gateway.reverse_image:*`
- [ ] 声明 `backends` 时导出了 `setup(ctx)`
- [ ] setup 幂等，`install` / `status` / `uninstall` 都能重复跑
- [ ] setup 只写 `ctx.paths.backendDir(id)` / `tempDir`
- [ ] 运行期读 `pluginConfig` / `pluginSecrets`，不读 `ctx.settings` / `ctx.config`
- [ ] 使用后端时读 `pluginBackends.dir(id)` / `state(id)`
- [ ] `match` 只读 URL，不读配置
- [ ] `npm run typecheck` / `npm test` 通过
- [ ] Release 带 `asg-extension.json`、entry、`SHA256SUMS`

## 11. 常见错误

| 现象 | 原因 |
| --- | --- |
| V2 字段没生效 | `api_version` 还是 `1` |
| platform 不对 | `fetch_channels[0].id` 不是 `platform:channel` |
| 搜索源展示名不对 | 入口 `engine.displayName` 优先于 `search_engines[].name` |
| 后端目录拿不到 | manifest 没声明 `backends`，`pluginBackends` 为 `undefined` |
| 后端显示已安装但不可用 | 只复制了文件，没写 `backendState`，`enabled` 为 false |
| 安装成功但运行时报缺配置 | 代码还在读 `ctx.settings` / `ctx.config` |
| 0.4.x 启动失败 | 旧 `bilibili` / `weibo` 配置没跑迁移脚本 |
