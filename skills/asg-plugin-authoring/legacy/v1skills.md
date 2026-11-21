---
name: asg-plugin-authoring
description: 为 agent-search-gateway（asg）编写、迁移或发布第三方插件时使用。适用于：从零生成一个 asg 插件仓库、把网关内置的 fetch/search 能力抽成独立插件、编写 asg-extension.json、打包单文件 ESM（index.mjs）、补测试，以及配置 GitHub Actions 的 v* Release 与 asg-plugin topic。
---

# 编写 asg 第三方插件（V1，仅 0.3.x）

> 仅适用于 0.3.x；0.4.0 起请使用 [`../v2skills.md`](../v2skills.md)。

本 skill 指导你从零产出一个可安装、可发布的 asg 插件仓库。所有结论以
`agent-search-gateway`（下称“网关”）0.3.x 的运行期约定为准。

> V2 专用指南见 [`../v2skills.md`](../v2skills.md)。0.4.0 起只接受 V2 manifest，
> V1 流程仅保留在本文与 [`references/`](references/)，用于维护 0.3.x 旧插件。

## 何时使用

- 用户要为某个站点写 **取件插件**（`fetch`），例如接管 `example.com/article/...`。
- 用户要为某个来源写 **搜索源 / 图搜源**（`engine`），例如新增 `gateway.search` 文本源。
- 用户要把网关里的内置实现迁出成独立插件仓库。
- 用户要给插件增加独立后端（服务、CLI、浏览器依赖），让插件自己安装/卸载。
- 用户要发布插件（`asg-extension.json` + `index.mjs` + `SHA256SUMS`）。

## 0. 运行期契约（先记住这几条）

1. 插件入口是**单文件 ESM**（默认 `index.mjs`），只认三个命名导出：
   - `export const fetch`：取件插件（`FetchPlugin` 形状）；
   - `export const engine`：引擎 provider（`EngineProvider` 形状）；
   - `export async function setup(ctx)`：可选；插件自管后端时使用，只在 CLI
     安装/更新/卸载时执行，网关运行时不调用。
   - 前两者可在同一文件同时导出（`provides: ["search", "fetch"]`）。
2. **禁止** `import "agent-search-gateway"` 或其内部模块（`src/...`）。运行期不保证宿主
   `node_modules` 存在，也不保证内部路径稳定。只允许：
   - Node 内置模块（`node:*`，esbuild 里保持 external）；
   - 自己的源码；
   - 需要第三方库时，把它 bundle 进 `index.mjs`。
3. `src/index.ts` 里如果写 `export const fetch = ...`，该模块内**不要再用全局 `fetch`**
   （会被同名绑定遮蔽）。把实现放到 `src/plugin.ts`，入口只做再导出。
4. 类型可以自由复制：建 `src/sdk/`，把需要的契约类型与运行期工具（`runCliProcess`、
   `Semaphore`、通道常量等）复制进去，不要从宿主 import。
5. `asg-extension.json` 支持 `id/name/version/api_version/provides/entry/description/config_schema`，
   `api_version: 2` 还可以写 `backends` / `fetch_channels` / `search_engines`。本版本
   不做严格字段校验，未知字段忽略；V1/V2 都会加载，V2 的后端通过
   `ctx.pluginBackends` 提供给插件使用。
6. 从 **0.3.4** 起，网关内置的 `bilibili` / `weibo` / `cnki` 已迁出为官方插件仓库，
   用户需要安装官方插件（见文末）而不是依赖内置实现。旧版本（≤0.3.3）会把这些 id
   当作内置能力拒绝安装，先升级网关。

## 1. 插件私有配置（`config_schema`）

插件需要的开关、上游地址、超时、上限等，**不要**读 `ctx.settings`，也不要求用户改网关核心
`settings/schema.ts`。在 manifest 里用可选的 `config_schema` 声明，网关会：

1. 用 schema 校验 `gateway.yaml → extensions.<manifest id>.config`；
2. 补齐 `default`，把结果递归冻结后注入 `ctx.pluginConfig`；
3. 校验失败时跳过整个插件（不会 import 入口），只记日志；
4. 提供 `asg extensions config` / `asg extensions secret` 读写。

### manifest 模板

```json
{
  "id": "example",
  "name": "Example",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "config_schema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true, "description": "总开关" },
      "base_url": { "type": "string", "description": "上游根地址" },
      "timeout_ms": {
        "type": "integer",
        "default": 15000,
        "minimum": 1000,
        "maximum": 120000,
        "description": "单次请求超时（毫秒）"
      },
      "mode": { "type": "string", "enum": ["fast", "full"], "default": "fast", "description": "模式" }
    }
  }
}
```

### 支持的 schema 子集

- 根必须是 `type: "object"` + `properties`（可为空对象）；
- 关键字：`type`（object/string/number/integer/boolean/array）、`description`、`default`、
  `enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`items`、`properties`、
  `required`、`additionalProperties`；
- 省略 `additionalProperties` 按 `false`，未知键直接拒绝；
- 递归深度 ≤ 8（根算第 1 层），节点总数 ≤ 256；
- 不支持 `$ref`、`pattern`、`oneOf` / `anyOf` / `allOf`、`format`；出现即报错；
- `default` 必须能通过该节点自己的 schema；
- `enum` 必须是非空数组，元素只能是字符串、数字或布尔值。

### 读取配置

```ts
const conf = ctx.pluginConfig ?? {};
const enabled = conf.enabled !== false;
const timeoutMs = typeof conf.timeout_ms === "number" ? conf.timeout_ms : 15000;
```

`match(url)` 不注入配置（只读 URL）；`enabled` / `available` / `fetch` / `routing` /
`plan` / `search` 才能读。`ctx.settings` / `ctx.config` 是核心内置实现的切片，外部插件不要依赖。

### 密钥

`config` 只放非敏感配置。密钥写 `secrets.yaml → extensions.<manifest id>.<name>`，
读 `ctx.pluginSecrets`：

```bash
asg extensions secret example --name api_key --stdin
```

`pluginSecrets` 同时兼容旧的 `extensions.<engineId>.<name>`（manifest id 优先），
`env:NAME` 已解析，空值不注入。

### 字段命名规范

统一 snake_case，优先复用核心词汇；发布后不改语义。禁止同义混用：

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
| 类别 | `categories`；单值 `category` | string[] / string | `category_list` |
| 模式 | `mode` + `enum` | string | `type`、`kind` |
| 文件/目录 | `*_path` / `*_dir` | string | `*_file`、`*_folder` |
| 用户代理 | `user_agent` | string | `ua` |
| 密钥 | 不放 config | — | 一律 `pluginSecrets` |

补充：单位写进后缀；布尔用肯定式；每个字段写 `description`；能安全默认的写 `default`；
每个 object 层级 `additionalProperties: false`。

### 命令

```bash
asg extensions config <id>
asg extensions config <id> --describe
asg extensions config <id> --get <key>
asg extensions config <id> --set <key>=<value> [--set ...]
asg extensions config <id> --unset <key>
asg extensions secret <id> --name <name> --stdin
```

写入前校验，失败不落盘；成功后整栈重启。默认值只在运行期补齐，不写回 `gateway.yaml`。
`asg engines enable/disable` 也可以按 `enabledPath` 写插件自己的 config，例如
`["extensions", "<manifest id>", "config", "enabled"]`。

## 2. 生成仓库骨架

```text
<repo>/
├── asg-extension.json           # manifest
├── package.json              # type: module；build / test / typecheck
├── package-lock.json         # npm install 生成，随提交
├── tsconfig.json
├── esbuild.config.mjs        # bundle → index.mjs
├── vitest.config.ts          # 只跑 TS 单测
├── .gitignore                # node_modules/ index.mjs SHA256SUMS
├── LICENSE                   # MIT
├── README.md                 # 能力、配置、安装、发版
├── src/
│   ├── index.ts              # 只导出 fetch / engine / setup
│   ├── plugin.ts             # fetch 实现（可拆成多文件）
│   ├── engine.ts             # engine 实现（可选）
│   ├── setup.ts              # 后端安装/卸载（可选，需 api_version: 2）
│   └── sdk/                  # 复制的契约类型与工具
├── test/
│   ├── exports.test.ts
│   ├── ...                   # 行为单测
│   └── build.test.mjs        # 构建产物冒烟（node --test）
└── .github/workflows/release.yml
```

### package.json

```json
{
  "name": "agent-search-gateway-plugin-example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "asg 插件：example.com 取件",
  "license": "MIT",
  "scripts": {
    "build": "node esbuild.config.mjs",
    "test": "npm run build && vitest run && node --test test/build.test.mjs",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "esbuild": "^0.28.2",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

**不要添加运行期 dependencies**。所有运行期代码必须被 bundle 进 `index.mjs`。

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*", "test/**/*.ts"],
  "exclude": ["node_modules", "dist", "index.mjs"]
}
```

### esbuild.config.mjs（单文件 ESM）

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["node:*"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
```

### vitest.config.ts

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 只跑 TS 单测；构建产物冒烟由 `node --test test/build.test.mjs` 负责。
  test: { include: ["test/**/*.test.ts"] },
});
```

### .gitignore

```gitignore
node_modules/
index.mjs
SHA256SUMS
```

### asg-extension.json

```json
{
  "id": "example",
  "name": "Example",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "description": "一句话说明插件能力"
}
```

字段细节见 `references/manifest.md`。

## 3. 实现 fetch（取件插件）

`src/index.ts`：

```ts
import { examplePlugin } from "./plugin.js";

export const fetch = examplePlugin;        // 运行期约定：命名导出 fetch
```

`src/plugin.ts` 必须满足 `FetchPlugin`：

| 字段 | 说明 |
| --- | --- |
| `id` / `platform` | 规范平台 ID（通常相同） |
| `name` / `displayName` | 内部名 / 展示名 |
| `capabilities` | 例如 `["article"]`、`["video", "comments"]`、`["pdf"]` |
| `aliases?` / `requires?` / `channels?` | 可选元数据 |
| `match(url)` | **纯 URL 判断**：不读配置、不抛错、不发请求 |
| `enabled?(ctx)` | 统一开关；返回 false 时宿主跳过插件并回退通用抓取 |
| `available?(ctx)` | 维护面可用性（健康检查/列表），**不参与** URL 匹配 |
| `fetch(url, ctx)` | 返回 `FetchPluginResult` |

结果形状：

```ts
{
  ok: boolean;            // 成功/失败
  status?: number;
  contentType?: string;
  finalUrl?: string;
  bytes?: Buffer;         // 二进制/文本产物
  html?: string;          // 或由宿主转 Markdown 的 HTML（二选一）
  errorCode?: string;     // 自定义错误码，例如 NOT_SUBSCRIBED
  errorMessage?: string;  // 面向 agent 的错误说明
}
```

`ctx` 里第三方插件只需要 `pluginConfig`（已补默认值、冻结）、`pluginSecrets`（已解析
`env:`）、`pluginBackends`（V2 声明 backends 时）与 `logger`。`settings` / `secrets` / `getSecret(path)` 是核心内置实现的切片，
外部插件不要依赖。不要假设宿主帮你处理 cookie/会话/重定向——插件自己管。

完整可复制示例见 `../examples/fetch-plugin.ts`；契约细节见 `references/fetch-plugin.md`。

## 4. 实现 engine（搜索源 / 图搜源）

`provides` 含 `"search"` 时必须导出 `engine`：

```ts
import { weiboProvider } from "./engine.js";

export const engine = weiboProvider;
```

`EngineProvider` 的关键字段：

| 字段 | 说明 |
| --- | --- |
| `id` | `${group}:${name}`，例如 `gateway.search:example` |
| `group` | `"gateway.search"`（文本源）或 `"gateway.reverse_image"`（图搜源） |
| `kind` | 固定 `"gateway"` |
| `routing(ctx)` | 返回 `category:<name>`，用于类别分发 |
| `requires` | 人类可读的前置条件；`secret:<name>` 表示需要用户在 CLI 配置的扩展密钥 |
| `available(ctx)` | 前置条件（密钥、上游开关） |
| `enabled?(ctx)` | 引擎自身开关；`enabledPath` 指向写入 `gateway.yaml` 的布尔路径 |
| `runtime` | `{ kind: "search", plan, search }` 或 `{ kind: "reverse_image", search }` |

扩展密钥：在 `requires` 里写 `secret:<name>`，运行期从 `ctx.pluginSecrets[<name>]`
读取（已解析 `env:NAME`，空值不注入）。写新键用
`asg extensions secret <manifest id> --name <name> --stdin`（`extensions.<id>.<name>`），
写旧键用 `asg engines secret <engine> --name <name> --stdin`
（`extensions.<engineId>.<name>`，继续兼容）。没配置时宿主会把 `available()` 判为 false，
插件内部仍应处理密钥缺失。

扩展的 `enabled` 与配置都读 `ctx.pluginConfig`，`enabledPath` 用
`["extensions", "<manifest id>", "config", "enabled"]`；`asg engines enable/disable`
会写回同一份配置，不需要核心 `search.<name>.enabled`。

文本源（`gateway.search`）：

```ts
runtime: {
  kind: "search",
  plan(categories, ctx) {
    // categories 是逗号分隔字符串；命中热搜类别时 hot = true
    return hasCategory(categories, "example_hot") ? { hot: true } : undefined;
  },
  async search(query, { hot, limit }, ctx) {
    // 返回 { ok: true, results, latencyMs } 或 { ok: false, error, latencyMs }
  },
}
```

用户可以用 `asg engines route <engine> --category <name> [--hot-category <name>]`
覆盖插件的 `routing()` / `plan()`（写 `gateway.yaml` 的 `extensions.<engineId>.routing`），
所以插件要把 `plan` 只当默认策略，不要在 `plan` 里做不可退让的副作用。

图搜源（`gateway.reverse_image`）：

```ts
runtime: {
  kind: "reverse_image",
  async search(input, ctx) {
    // input: { kind: "url", url } | { kind: "bytes", bytes, filename, mime }
    // 返回 SourceCall：{ ok: true, results, latencyMs } | { ok: false, error }
  },
}
```

完整示例见 `../examples/search-engine.ts`；细节见 `references/search-engine.md`。

## 5. 测试

最低要求：

```ts
// test/exports.test.ts
import { describe, expect, it } from "vitest";
import { fetch as plugin } from "../src/index.js";

describe("导出形状", () => {
  it("导出 fetch 插件对象", () => {
    expect(plugin).toBeTypeOf("object");
    expect(typeof plugin.match).toBe("function");
    expect(typeof plugin.fetch).toBe("function");
  });

  it("match 纯 URL 判断", () => {
    expect(plugin.match(new URL("https://example.com/article/1"))).toBe(true);
    expect(plugin.match(new URL("https://example.org/article/1"))).toBe(false);
  });
});
```

若导出 `engine`，追加：

```ts
expect(engine.group).toBe("gateway.search");
expect(engine.runtime?.kind).toBe("search");
```

构建产物冒烟（`node --test`）：

```js
// test/build.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

test("bundle 可加载并导出 fetch", async () => {
  const mod = await import("../index.mjs");
  assert.equal(typeof mod.fetch, "object");
  assert.equal(typeof mod.fetch.match, "function");
  assert.equal(typeof mod.fetch.fetch, "function");
});
```

运行：

```bash
npm install
npm run typecheck
npm test        # build + vitest + node --test
```

测试建议：

- 用本地 HTTP 桩服务器 / 假 CLI 脚本覆盖 `fetch` 的主路径与错误码，不打真实站点；
- 密钥、网络、登录态都从 `ctx` 注入，测试里直接构造设置对象，不依赖网关的 settings loader；
- 需要指向本地桩服务器时，把端点/策略导出成可变对象（如 `endpoints`、`policy`），测试里改写。

## 6. 后端与 `setup`（可选，`api_version: 2`）

插件需要独立服务、CLI、浏览器依赖等后端时，不要在核心仓库里加安装脚本，也不要让
用户手工下载。做法是：

1. manifest 升到 `api_version: 2`，声明 `backends`（只写身份，不写下载地址/版本）：

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "0.1.0",
  "api_version": 2,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "backends": [
    { "id": "example-api", "name": "Example API", "aliases": ["example-service"] },
    { "id": "example-cli", "name": "Example CLI" }
  ]
}
```

2. 在入口（或再导出）实现 `setup(ctx)`：

```ts
import path from "node:path";

export async function setup(ctx) {
  const id = "example-cli";
  const target = ctx.paths.backendDir(id);
  const executable = path.join(target, "example-cli");

  if (ctx.action === "status") {
    return { installed: await ctx.exists(executable) };
  }
  if (ctx.action === "uninstall") {
    await ctx.remove(target, { recursive: true, force: true });
    await ctx.backendState.clear(id);
    return { removed: true };
  }
  if (await ctx.exists(executable)) {
    return { installed: true, reused: true };
  }

  await ctx.mkdir(target, { recursive: true });
  const legacy = ctx.paths.legacyBackendDir(id);
  if (await ctx.exists(legacy)) {
    await ctx.copy(legacy, target); // 旧目录只读：只复制，不移动/删除
  }
  if (!(await ctx.exists(executable))) {
    const archive = path.join(ctx.paths.tempDir, "example-cli.tar.gz");
    await ctx.download("https://example.com/releases/example-cli.tar.gz", archive, {
      sha256: "<64 位十六进制 sha256>",
    });
    await ctx.extract(archive, target, { stripComponents: 1 });
  }
  const version = await ctx.run(executable, ["--version"], { cwd: target });
  if (version.code !== 0) throw new Error(version.stderr || version.stdout);
  await ctx.backendState.write(id, {
    installed: true,
    enabled: true,
    version: version.stdout.trim(),
    path: target,
  });
  return { installed: true, version: version.stdout.trim() };
}
```

关键约束：

- `ctx.paths.dataDir` 是 `data/extension-data/<id>`，是插件唯一可写数据目录；
  `ctx.paths.backendDir(id)` 在其中；更新插件目录不会丢后端。
- 写操作只能落在 `dataDir` / `tempDir`；`pluginDir` 与 `ctx.paths.legacyBackendDir(id)`
  只能读。旧 `data/backends` 只复制，不移动、不删除。
- `ctx.download` / `fetchText` / `fetchJson` 只接受 https；`download` 提供 `sha256` 时会
  校验，不匹配删除文件；需要单独校验已有文件时用 `ctx.sha256(file)`。
- `ctx.config` 只写 `extensions.<id>.config`，按 `config_schema` 校验；失败不落盘。
- `ctx.backendState` 写 `data/extension-data/<id>/backends.json`，`asg extensions list`
  只读它展示 `BACKENDS`。
- action 为 `install` / `update` / `uninstall` / `status`；当前 CLI 会传
  `install` / `status` / `uninstall`，`update` 是预留。所有 action 都要幂等、可重跑。
- 整次 setup 默认超时 10 分钟；子进程**不是安全沙箱**。不要 import 网关内部模块。

完整契约与示例见 [`references/setup.md`](references/setup.md)。

## 7. CI 发布（tag `v*`）

`.github/workflows/release.yml`：

```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: sha256sum index.mjs asg-extension.json > SHA256SUMS
      - env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${GITHUB_REF_NAME}" \
            index.mjs asg-extension.json SHA256SUMS \
            --title "agent-search-gateway-plugin-example ${GITHUB_REF_NAME}" \
            --generate-notes
```

发布步骤：

1. 同时改 `asg-extension.json` 与 `package.json` 的版本号；
2. `git tag v0.1.0 && git push origin v0.1.0`；
3. 等 Actions 创建 Release（资产：`index.mjs`、`asg-extension.json`、`SHA256SUMS`）。

`version` 必须与 tag 去掉 `v` 后一致；安装器会校验 `SHA256SUMS`，不要手工替换资产。
细节见 `references/release.md`。

## 8. 发现与安装

- 给 GitHub 仓库加 topic：**`asg-plugin`**（`asg extensions search` 依赖它）；
- 用户安装：

```bash
asg extensions install <owner>/<repo>@0.1.0   # 默认执行 manifest 声明的后端 setup
asg extensions list                           # BACKENDS 列显示后端状态
asg extensions setup <id> --status
```

安装完成不会自动重启网关；`config` / `secret` 写入才会整栈重启。

官方插件仓库：

```bash
asg extensions install djasdh/agent-search-gateway-plugin-bilibili@0.2.0
asg extensions install djasdh/agent-search-gateway-plugin-weibo@0.2.0
asg extensions install djasdh/agent-search-gateway-plugin-cnki@0.2.0
```

## 9. 交付前检查清单

- [ ] `src/index.ts` 导出 `fetch`（以及需要时的 `engine`），且没有遮蔽全局 `fetch`；
- [ ] 有后端时导出 `setup`，`api_version: 2`，`backends[].id` / `name` / `aliases` 合法；
- [ ] `setup` 的 `install` / `status` / `uninstall` 都能重复执行，已安装时不会重复下载；
- [ ] setup 只写 `ctx.paths.backendDir(id)` / `tempDir`，旧 `data/backends` 只复制不删除；
- [ ] setup 的下载用 https + `sha256`，解压/命令失败会抛错；
- [ ] `match` 只做 URL 判断，不读配置、不发请求、不抛错；
- [ ] 没有 import `agent-search-gateway` 或宿主 `node_modules`；
- [ ] 私有配置已写进 `config_schema`，字段名 snake_case，每个字段有 `description`，
      能安全默认的写了 `default`，每个 object 层级 `additionalProperties: false`；
- [ ] 插件只读 `ctx.pluginConfig` / `ctx.pluginSecrets`，没有依赖 `ctx.settings` / `ctx.config`；
- [ ] 密钥没有放进 `config`，而是走 `asg extensions secret`；
- [ ] `package.json` 无运行期依赖，`npm run build` 只产出 `index.mjs`；
- [ ] `asg-extension.json` 的 `api_version` 为 `1` 或 `2`，`version` 与 tag 一致；
- [ ] `asg-extension.json`、`package.json` 版本同步；
- [ ] `npm run typecheck`、`npm test` 通过（含 setup 幂等与旧目录迁移测试）；
- [ ] `.github/workflows/release.yml` 用 `contents: write` 并上传三个资产；
- [ ] README 写明能力、配置、安装命令、后端安装/卸载与发版步骤；
- [ ] GitHub topic `asg-plugin` 已设置（发布后手动加）。

## 参考文件

- [`../v2skills.md`](../v2skills.md)：V2 专用指南（manifest、fetch_channels、search_engines、backends、pluginBackends、迁移）。
- `references/manifest.md`：manifest 字段、`api_version` 1/2、`backends`、校验规则、安装目录与资产。
- `references/setup.md`：`setup(ctx)` 完整契约、路径/API、幂等与旧目录迁移。
- `references/fetch-plugin.md`：`FetchPlugin` 全字段、结果形状、上下文与错误约定。
- `references/search-engine.md`：`EngineProvider` 两种 runtime、routing/plan 语义、返回结构。
- `references/release.md`：构建、发布、安装器行为与常见坑。
- `../examples/fetch-plugin.ts`：最小可复制 fetch 插件。
- `../examples/search-engine.ts`：最小可复制 search engine。
