# 插件私有配置：manifest 声明，extensions 段持久化

- 状态：已接受
- 日期：2026-11-15
- 相关：`docs/extensions.md`、`docs/engine-provider.md`、`docs/fetch-plugin-contract.md`、`docs/cli-contract.md`

> **状态更新（0.4.0）**：旧 `extensions.<engineId>.<name>` 密钥键不再读取；本文中
> “兼容旧键”的描述仅适用于 0.3.x。

## 背景（Context）

第三方扩展的配置一直被塞在核心的 `extensions` 映射里，但只有一层无类型的
`config: Record<string, unknown>`：网关不知道插件有哪些字段、类型是否正确、默认值是什么，
CLI 也无法给出字段说明或做写入前校验。

更麻烦的是插件如果要“像内置功能一样”有配置，只能改核心：

- 在 `src/settings/schema.ts` 增加专用配置段；
- 在 `src/settings/index.ts` 暴露切片；
- 插件读 `ctx.settings.<plugin>` / `ctx.config.<plugin>`。

这条路径对第三方插件不成立：插件是独立仓库、单文件 ESM，不可能要求用户改网关源码。
`EngineProviderContext` / `FetchPluginContext` 里的 `pluginConfig` 一度只是占位，
没有 manifest 声明、没有来源约定，插件作者无法安全依赖。

另一个必须同时解决的问题是密钥。`gateway.yaml` 只应放非敏感配置，密钥必须留在
`secrets.yaml`，并且同一份插件配置在 CLI、运行期、文档里只能有一套键名。

## 决策（Decision）

1. **manifest 增加可选 `config_schema`。**

   `asg-plugin.json` 可以声明一个刻意收窄的 JSON Schema 子集，描述插件私有配置。
   根必须是 `type: "object"` 且声明 `properties`；支持 `type`（object/string/number/
   integer/boolean/array）、`description`、`default`、`enum`、`minimum`、`maximum`、
   `minLength`、`maxLength`、`items`、`properties`、`required`、`additionalProperties`。
   省略 `additionalProperties` 按 `false`，未知键直接拒绝；`$ref`、`pattern`、
   `oneOf/anyOf/allOf`、`format` 等一律报错而不是静默忽略。递归深度 ≤ 8，节点总数 ≤ 256。

2. **配置存 `gateway.yaml → extensions.<manifest id>.config`。**

   键使用 manifest 的 `id`（也是安装目录名），不是 engineId。插件可能同时提供
   `search` 与 `fetch`，或 engine id 与 manifest id 不同（`gateway.search:weibo` vs `weibo`）；
   以 manifest id 为唯一键可以保证“一份插件配置”。

3. **加载时校验、补默认值、非法即跳过。**

   loader 在 import 入口模块之前先校验 `config_schema` 定义，再用它校验用户配置：
   未知键、类型错误、枚举越界、必填缺失都会让该插件整包跳过，只记 error + warn，
   不影响其它插件与网关启动。默认值只在运行期补齐，不写回配置文件。
   没有 `config_schema` 的旧 manifest 行为不变：`config` 必须是对象，原样透传；
   空对象不注入，避免把所有未配置插件都包装一遍。

4. **运行期通过 `ctx.pluginConfig` / `ctx.pluginSecrets` 注入。**

   `EngineProviderContext` 与 `FetchPluginContext` 都提供：

   - `pluginConfig?: Readonly<Record<string, unknown>>`：已补默认值并递归冻结；
   - `pluginSecrets?: Record<string, string>`：已解析 `env:NAME`，空值不注入。

   fetch 的 `match(url)` 保持纯 URL 判断，不注入配置；只有 `enabled` / `available` /
   `fetch` 能读。`ctx.config` / `ctx.secrets`（fetch 侧为 `ctx.settings` / `ctx.secrets`）
   继续保留给核心内置实现，不再作为第三方扩展的契约。

5. **密钥使用 manifest id 键，旧 engineId 键兼容。**

   新键：`secrets.yaml → extensions.<manifest id>.<name>`；
   旧键：`secrets.yaml → extensions.<engineId>.<name>` 继续读取。
   loader 合并两者，同名时 manifest id 优先。`asg engines secret` 仍按 engineId 写旧键，
   新增 `asg extensions secret` 写新键。`requires: ["secret:<name>"]` 的语义不变，
   只声明依赖，缺失时 `available()` 强制 false。

6. **CLI 提供配置读写，写入即重启。**

   新增：

   ```text
   asg extensions config <id> [--get [key]] [--set key=value]... [--unset key]... [--file <path>] [--describe]
   asg extensions secret <id> --name <name> --stdin | --clear
   ```

   `config` 写入前用同一套 schema 校验；失败不写文件、不重启。写入成功后整栈重启一次，
   并提示 MCP 连接会断开。`--set` / `--unset` / `--file` 只落盘用户值，默认值不落盘；
   `--get` / 无参数读取时展示补齐默认值后的完整配置；`--describe` 输出顶层字段表。
   `secret` 只从 stdin 读值，不回显明文，文件权限固定 `0600`。

7. **`enabledPath` 可以指向插件自己的配置。**

   `gateway.search` 扩展可以把 `enabledPath` 设为
   `["extensions", "<manifest id>", "config", "enabled"]`，`asg engines enable/disable`
   会按路径把布尔值写回 `gateway.yaml`，与 `asg extensions config <id> --set enabled=...`
   修改同一个开关。`GatewayStore` 只按路径写，不需要知道配置属于核心还是插件。

8. **统一字段命名。**

   配置字段统一 snake_case，优先复用核心词汇：`enabled`、`base_url`、`timeout_ms`、
   `limit`、`<resource>_limit`、`max_retries`、`retry_backoff_ms`、`cache_ttl_ms`、
   `max_bytes` / `max_chars`、`languages`、`categories` / `category`、`mode`、`*_path` /
   `*_dir`、`user_agent`。禁止 `enable`、`disabled`、`timeout`、`max`、`lang` 等同义写法；
   单位写进后缀，布尔用肯定式，每个字段写 `description`，能安全默认的写 `default`。
   密钥不放 `config`。

## 后果（Consequences）

- 插件可以不改核心就拥有强类型、可校验、可发现、可设默认值的配置。
- 配置只在一个地方：`extensions.<manifest id>.config`；CLI、loader、文档共用。
- 配置变更需要整栈重启才生效；目前不支持热更新。
- 每个 manifest id 只有一份配置，不支持同一插件多实例。
- 旧网关不识别 `config_schema`，manifest 的严格校验会拒绝带该字段的新插件；
  升级网关后再安装。
- schema 子集不表达跨字段约束与复杂联合类型；需要时在插件内部再做运行期校验。
- `asg engines enable` 的 `secret:` 依赖检查与运行期一致：先查
  `extensions.<manifest id>.<name>`，解析后为空再回退
  `extensions.<engineId>.<name>`；两者任一非空即满足。
- `routing` 仍按 engineId 存 `extensions.<engineId>.routing`，与 `config` 的键不同，
  文档必须写清楚这个不对称。

## 考虑过的替代方案（Alternatives）

- **完全透传，不做 schema**：实现最省事，但无法在写文件前发现拼写错误、类型错误，
  CLI 也无法 `--describe`；退回现状，否决。
- **每个插件一个独立配置文件**：需要新目录、权限、备份与同步策略，配置真值被拆成多份，
  也与现有“gateway.yaml + secrets.yaml”模型冲突；否决。
- **引入完整 JSON Schema 校验器**：表达力强，但体积与错误信息不可控，插件作者容易写出
  当前运行期并不支持的语义（`$ref` / `pattern` / 联合类型）；先收窄子集，否决完整实现。
- **配置按 engineId 键**：search 插件同时提供 fetch 时会有两个身份，engineId 与 manifest id
  不一致还会产生两份配置；以 manifest id 为唯一键，否决按 engineId 存配置。
