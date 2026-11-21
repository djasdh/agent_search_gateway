# asg-extension.json（manifest）

插件根目录放 `asg-extension.json`（V2）；旧插件可继续用 `asg-plugin.json`（V1）。
本版本不做严格字段校验：未知字段忽略，只保留类型、必填项和路径安全约束。

## 字段

| 字段 | 版本 | 必填 | 规则 |
| --- | --- | --- | --- |
| `id` | V1/V2 | 是 | 3–64 位小写字母/数字/`.` `_` `-`，首尾必须是字母或数字；也是安装目录名 |
| `name` | V1/V2 | 是 | 展示名 |
| `version` | V1/V2 | 是 | 语义化版本；必须与 Release tag 去掉 `v` 后一致 |
| `api_version` | V1/V2 | 是 | `1` 或 `2` |
| `provides` | V1/V2 | 是 | 元素只能是 `"search"` / `"fetch"` |
| `entry` | V1/V2 | 是 | 单个 `.mjs` / `.js` 文件名；不能含 `/`、`\`、`..`、`:`，不能是绝对路径 |
| `description` | V1/V2 | 否 | 人类可读摘要 |
| `config_schema` | V1/V2 | 否 | 私有配置声明（JSON Schema 子集，见下文）；省略时 `config` 原样透传 |
| `platform` | V1 | 否 | 平台回退值；V2 从 `fetch_channels[].id` 前缀派生 |
| `backends` | V2 | 否 | 后端声明数组，见下文 |
| `fetch_channels` | V2 | 否 | 抓取通道声明 |
| `search_engines` | V2 | 否 | 搜索源声明 |

V1 与 V2 都会加载。V2 的 `fetch_channels` 派生 platform，`search_engines` 补展示名；
声明 `backends` 时，运行时通过 `ctx.pluginBackends` 使用自己安装的后端。

## 示例（无后端）

```json
{
  "id": "example",
  "name": "Example",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "description": "example.com 文章取件"
}
```

同时提供搜索源与取件（仍不需要后端）：

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["search", "fetch"],
  "entry": "index.mjs",
  "description": "示例搜索源 + 取件"
}
```

## 后端声明（`backends`，`api_version: 2`）

插件需要独立服务、CLI、浏览器依赖等后端时，在 manifest 里声明身份，并在入口导出
`setup(ctx)` 自己安装。`backends` 只是元数据，不包含代码、下载地址或版本。

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 3–64 位小写字母/数字/`.` `_` `-`，首尾必须是字母或数字；同一插件内唯一 |
| `name` | 是 | 1–80 个字符的展示名 |
| `description` | 否 | 任意字符串 |
| `aliases` | 否 | 旧 `asg plugins` 输入名数组；元素非空且不重复 |

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "0.1.0",
  "api_version": 2,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "description": "示例：自管 example-api / example-cli",
  "backends": [
    {
      "id": "example-api",
      "name": "Example API",
      "description": "示例 HTTP 服务",
      "aliases": ["example-service"]
    },
    {
      "id": "example-cli",
      "name": "Example CLI",
      "description": "示例命令行工具"
    }
  ]
}
```

- `aliases` 只用于兼容旧输入名：`asg plugins install <name>` / `remove <name>`
  会按 `backend.id` 或 `aliases` 精确匹配，命中后走同一套 setup。
- 新插件不要用旧名作为主标识；声明稳定的 `backend.id`。
- 声明了 `backends` 就应导出 `setup`；否则 `asg extensions install` / `setup <id>`
  会因“入口没有导出 setup 函数”失败（可以 `--no-setup` 先安装，修好后再 setup）。
- `update` action 是契约预留；当前 CLI 升级插件时传的是 `install`，插件应按幂等方式
  处理 `install` / `update`，不要假设 `update` 一定会出现。
- 完整上下文、路径与 API 见 [`setup.md`](setup.md)。

## 抓取通道与搜索源（V2）

```json
{
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
  ]
}
```

- `fetch_channels[].id` 使用 `platform:channel`；同一扩展内使用同一 platform 前缀。
- `search_engines[].id` 使用 `gateway.search:<name>` 或 `gateway.reverse_image:<name>`。
- 本版本只做安装与列表展示，运行时不消费这些字段。

## provides 与命名导出的对应关系

| `provides` | 运行期从 `entry` 读取的导出 |
| --- | --- |
| `["fetch"]` | `fetch` |
| `["search"]` | `engine` |
| `["search", "fetch"]` | `engine` 与 `fetch` 同时存在 |

`setup` 是独立的可选导出，不属于 `provides`；网关运行时不调用它。

导出名写错时，安装本身可能成功（安装层只校验资产与 manifest），但运行期加载会
失败或该能力不生效，因此务必在测试里断言导出形状；声明了 `backends` 时还要测试
`setup` 导出与幂等。

## 私有配置：`config_schema`

插件有自己的配置（开关、超时、上游地址、上限等）时，用 `config_schema` 声明。
网关会用它校验 `gateway.yaml → extensions.<id>.config`，补齐默认值，再注入
`ctx.pluginConfig`；没有声明时 `config` 原样透传。

```json
{
  "config_schema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true, "description": "总开关" },
      "base_url": { "type": "string", "description": "上游根地址" },
      "timeout_ms": {
        "type": "integer",
        "default": 15000,
        "minimum": 1000,
        "maximum": 60000,
        "description": "单次请求超时（毫秒）"
      },
      "mode": {
        "type": "string",
        "enum": ["fast", "full"],
        "default": "fast",
        "description": "抓取模式"
      }
    }
  }
}
```

支持的子集：

- 根必须是 `type: "object"` + `properties`（可为空对象）；
- 关键字：`type`（object/string/number/integer/boolean/array）、`description`、
  `default`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`items`、
  `properties`、`required`、`additionalProperties`；
- 省略 `additionalProperties` 按 `false`（未知键直接拒绝）；
- 递归深度 ≤ 8（根算第 1 层），节点总数 ≤ 256；
- 不支持 `$ref`、`pattern`、`oneOf` / `anyOf` / `allOf`、`format`；出现即报错；
- `default` 必须能通过该节点自己的 schema。
- `enum` 必须是非空数组，元素只能是字符串、数字或布尔值。

用户侧命令：

```bash
asg extensions config <id>
asg extensions config <id> --describe
asg extensions config <id> --set timeout_ms=20000
asg extensions secret <id> --name api_key --stdin
```

配置存 `extensions.<manifest id>.config`（键是 manifest id，不是 engineId）；
写入前校验，失败不落盘；成功后整栈重启。默认值只在运行期补齐，不写回文件。
**密钥不要放进 `config`**，一律用 `secrets.yaml → extensions.<id>.<name>`。

setup 里可以用 `ctx.config.get/patch/replace/unset` 读写同一段配置；规则、校验与
“失败不落盘”与 CLI 一致。详见 [`setup.md`](setup.md)。

字段命名规范见 `../v1skills.md` 的“插件私有配置”一节：统一 snake_case，
`enabled` / `base_url` / `timeout_ms` / `limit` / `categories` / `mode` / `user_agent`，
单位写进后缀，布尔用肯定式。

## 安装目录、数据目录与资产

- 安装目录：`<root>/data/extensions/<id>/`，目录名必须与 `id` 一致；
- 目录存在即视为已安装，没有额外注册表；
- 安装时先下载到 `.staging-*`，成功后原子换入；旧目录进 `.trash-*`；
- 插件可写数据：`<root>/data/extension-data/<id>/`，**更新插件不会覆盖**；
- 旧后端目录 `<root>/data/backends/<name>/` 只读，只能复制、不能移动/删除；
- 卸载只删插件目录；`asg extensions remove` 默认还会删 `data/extension-data/<id>`，
  `--keep-data` 保留，`--force` 跳过卸载 setup。

一个 Release 至少包含：

| 资产 | 说明 |
| --- | --- |
| `asg-extension.json` | manifest 本体 |
| `index.mjs`（或 `entry` 指定的文件） | 单文件 ESM，不能依赖同目录其它文件；可同时导出 `fetch` / `engine` / `setup` |
| `SHA256SUMS` | `sha256sum` 格式，必须覆盖前两者 |

安装器只接受 **https** 下载地址，并会先校验 manifest，再按 `SHA256SUMS` 校验两个文件；
校验失败立即清理 staging。安装成功后默认执行后端 setup（`--no-setup` 可跳过）。

## 版本与内置 id 注意事项

- tag 建议用 `v<version>`；安装器也兼容不带 `v` 的 tag，但 `version` 必须与 tag 对应。
- 从网关 **0.3.4** 起，`bilibili` / `weibo` / `cnki` 已迁出为官方插件仓库，可以按上述 id 安装；
  0.3.3 及更早版本会把这些 id 当作内置能力拒绝安装/卸载，先升级网关。
- 私有仓库的 Release 资产目前不保证可安装（下载不带 Release asset API 鉴权）。
