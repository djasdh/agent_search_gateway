# asg 第三方插件模板（V2）

这是一个最小可发布的 asg V2 插件模板：TypeScript 源码经 esbuild 打成**单文件 ESM**，
Release 只包含 `index.mjs`、`asg-extension.json` 与 `SHA256SUMS`。

> 0.4.0 起只接受 V2 manifest（`asg-extension.json`，`api_version: 2`）。
> `asg-plugin.json` 是 0.3.x 的旧格式，本示例不再提供。

## 目录

```text
.
├── asg-extension.json        # 插件 manifest（api_version: 2）
├── esbuild.config.mjs        # 单文件打包配置
├── src/index.ts              # 插件实现（导出 fetch / engine）
├── test/plugin.mjs           # 构建后的冒烟测试
└── .github/workflows/release.yml
```

## 开发

```bash
npm install
npm run build     # 生成 index.mjs
npm test          # 先构建，再用 node --test 跑冒烟测试
```

`src/index.ts` 目前导出 `fetch` 对象（`FetchProvider` 形状）；如果 `provides` 包含
`search`，还需要从同一文件导出 `engine`。不要 import 网关内部模块，也不要依赖
宿主 `node_modules` 里的第三方包（Node 内置模块可以）。

## manifest

`asg-extension.json` 的关键字段：

- `id`：安装目录名，3–64 位小写字母/数字/`.` `_` `-`；
- `version`：必须与 Release tag 去掉 `v` 后一致；
- `api_version`：固定为 `2`；
- `provides`：`["search"]`、`["fetch"]` 或两者；
- `entry`：单个 `.mjs` / `.js` 文件名，不能带路径；
- `fetch_channels`：抓取通道，id 为 `platform:channel`；本示例是 `example:http`；
- `search_engines`：搜索源，id 为 `gateway.search:<name>` /
  `gateway.reverse_image:<name>`（本示例未使用）；
- `config_schema`（可选）：插件私有配置的 JSON Schema 子集。

运行期配置只读 `ctx.pluginConfig` / `ctx.pluginSecrets`，不要读 `ctx.settings`。
Manifest 不写 V1 的 `platform` 字段；platform 从 `fetch_channels[0].id` 前缀派生。

## 配置

本示例声明了 `enabled`、`timeout_ms`、`user_agent` 三个字段：

```bash
# 查看补齐默认值后的配置
asg extensions config example-fetch

# 查看字段说明
asg extensions config example-fetch --describe

# 修改 / 删除
asg extensions config example-fetch --set timeout_ms=20000
asg extensions config example-fetch --set user_agent=asg-example
asg extensions config example-fetch --unset user_agent

# 密钥（只从 stdin 读，不回显）
echo "$EXAMPLE_COOKIE" | asg extensions secret example-fetch --name cookie --stdin
```

配置落在 `gateway.yaml → extensions.example-fetch.config`，写入前按 `config_schema`
校验，失败不落盘；成功后整栈重启。默认值只在运行期补齐，不写回文件。

## 发布

1. 修改 `asg-extension.json` 与 `package.json` 里的版本号（例如 `0.1.0`）。
2. 提交并打 tag：`git tag v0.1.0 && git push origin v0.1.0`。
3. GitHub Actions 会执行 `npm ci`、`npm run build`，生成
   `sha256sum index.mjs asg-extension.json > SHA256SUMS`，并创建 Release。

发布后用户即可安装：

```bash
asg extensions install <owner>/<repo>@0.1.0
asg extensions list
```

## 发现

请给仓库加上 GitHub topic：**`asg-plugin`**。这样用户可以通过
`asg extensions search` 找到它。

## 当前限制

插件代码没有沙箱，与网关同进程运行；只安装可信来源。配置变更需要整栈重启后生效，
不支持同一插件多实例。运行时加载、权限与沙箱会在后续版本继续收紧。
