# 插件自管后端与 setup 钩子

> 0.4.0 保留 asg plugins 与迁移脚本；0.4.1 删除。

- 状态：已接受
- 日期：2026-11-16
- 相关：`docs/extensions.md`、`docs/cli-contract.md`、`scripts/migrations/README.md`、
  ADR-0016（后端安装脚本与网关自更新）、ADR-0021（插件私有配置）

## 背景（Context）

0.3.x 之前，外部后端由核心维护的 `scripts/backends/` 安装脚本管理：

- 后端名单、安装方式、配置键都写死在核心仓库；
- 安装目录是 `data/backends/<name>/`，由脚本修改 `gateway.yaml`；
- `asg plugins install|remove` 只是这些脚本的 facade；
- 新增一个后端需要改核心仓库，插件作者无法只在自己的仓库里交付“代码 + 后端”。

同时，第三方插件已经可以声明 `provides`、`config_schema`，但插件所需的独立服务、
CLI 或浏览器依赖仍没有统一的安装生命周期。把后端继续留在核心里会带来三个问题：

1. **身份分散**：同一个后端在核心脚本、`gateway.yaml`、`data/backends`、插件 manifest
   里各有一套名字，旧安装名/通道名无法自然迁移。
2. **插件更新丢数据**：安装器原子替换整个 `data/extensions/<id>`，任何放在插件目录里的
   后端都会在更新时丢失。
3. **无法幂等/无法续跑**：手工脚本难以表达“已安装就跳过”“失败后重试”“卸载只删自己”
   这些插件私有逻辑，也无法让第三方插件自带后端。

`data/backends` 还必须继续可用：0.3.x 用户已经有安装在里面的后端，升级不能要求一次性
手工迁移，更不能在失败时删除旧目录。

## 决策（Decision）

1. **manifest `api_version: 2` 声明后端身份。**

   `asg-plugin.json` 增加可选的 `backends` 数组，每项只包含：

   ```json
   {
     "id": "example-api",
     "name": "Example API",
     "description": "可选说明",
     "aliases": ["example-service"]
   }
   ```

   - `backends` 只属于 `api_version: 2`。
   - 过渡版（本文之后）取消了严格字段校验：未知字段忽略，不再检查 backend id 重复。
   - `aliases` 只用于兼容 `asg plugins` 的旧输入名，不是新的安装命令。
   - `backends` 只描述身份，不承载代码、下载地址或版本；核心不内置任何平台名。

2. **插件入口导出 `setup(ctx)`，后端安装逻辑归插件。**

   CLI 在安装/更新/卸载/查看状态时启动独立 Node 子进程，动态 import 插件入口并调用
   `setup`。action 为 `install` / `update` / `uninstall` / `status`。当前 CLI 会传
   `install`（安装、单独 setup）、`status`、`uninstall`；`update` 是契约预留，插件应按
   幂等方式处理。

   `ctx` 提供：

   - 身份：`action`、`backends`、`plugin { id, name, version }`；
   - 宿主：`host { os, arch }`（刻意不提供 `isWindows` 之类派生字段）；
   - 路径：`pluginDir`、`dataDir`、`backendDir(id)`、`tempDir`、`legacyBackendDir(id)`、
     `root`、`config`、`secrets`；
   - 能力：`fs`、`download` / `fetchText` / `fetchJson`、`run`、`config`、`state`、
     `backendState`、`log` / `progress`。

   所有能力都由父进程通过 IPC 代理，插件不需要 import 网关内部模块。

3. **数据目录与安装目录分离。**

   - 插件安装目录：`data/extensions/<id>/`，只读；更新时整体原子替换。
   - 插件数据目录：`data/extension-data/<id>/`，可写；后端默认在
     `data/extension-data/<id>/backends/<backend-id>/`，临时文件在 `tmp/`。
   - 这样插件更新不会删除已安装后端，卸载也能由 `--keep-data` 决定是否保留数据。

4. **旧 `data/backends` 是只读迁移源。**

   setup 可以通过 `ctx` 读取 `data/backends/<旧目录名>` 并复制到新位置，但通过 `ctx`
   的写/删操作会被拒绝；CLI 与迁移脚本也不会删除它。迁移遵循“只复制，不删除”，
   失败时旧环境仍可用。
   旧目录名可能由宿主映射决定，插件应使用 `ctx.paths.legacyBackendDir(id)`，不要假设它
   一定等于 `backend.id`。

5. **写入边界与配置边界收窄。**

   - `ctx` 的写操作只能落在 `dataDir` / `tempDir`；`rename` 的源也必须是可写路径；
     真实路径检查会拦截符号链接逃逸。
   - 下载只允许 https；`download` 支持 sha256，校验失败会删除文件。
   - `ctx.config` 只能写 `gateway.yaml → extensions.<plugin.id>.config`，按 manifest
     `config_schema` 校验；失败不落盘。它不能写密钥或其他插件配置。
   - `state` / `backendState` 分别写 `data/extension-data/<id>/state.json` 与
     `backends.json`，使用原子写。
   - 这些是防误用边界，不是安全沙箱：setup 子进程仍以用户权限运行，可执行任意命令。

6. **CLI 增加完整的后端生命周期命令。**

   ```text
   asg extensions install <owner/repo>[@version] [--backend <id>]... [--no-setup]
   asg extensions setup <id> [--backend <id>]... [--status] [--uninstall]
   asg extensions remove <id> [--keep-data] [--force]
   asg extensions list
   ```

   - `install` 默认对 manifest 声明的全部后端执行 `install` setup；`--backend` 缩小范围，
     `--no-setup` 跳过执行但仍报告后端。
   - `setup` 默认 `install`，`--status` / `--uninstall` 切换 action。
   - `remove` 默认先执行 `uninstall` setup，再删插件目录；成功后默认删除
     `data/extension-data/<id>`，`--keep-data` 保留；`--force` 跳过 setup。
   - `list` 只读 `data/extension-data/<id>/backends.json`，不执行插件代码；表格增加
     `BACKENDS` 列，JSON 返回每个后端的 `installed` / `enabled` / 可选 `version` / `path`。
   - `install` / `setup` / `remove` 不自动重启；`config` / `secret` 仍按配置写入契约
     整栈重启。

7. **`asg plugins` 降级为兼容 facade。**

   解析顺序：

   1. 在已安装 manifest 的 `backends[]` 中按 `backend.id` / `aliases` 精确匹配，
      命中后调用对应后端的 setup；
   2. 未命中时回退 `scripts/backends/cli.mjs`，名字原样透传；
   3. 都没有则 `PLUGIN_UNKNOWN`。

   `list` 合并 manifest 后端与未被覆盖的 `data/backends/*` 旧安装；P1 的
   `platform` / `channel` / `channel_id` 字段保留为空字符串。

8. **迁移分阶段推进。**

   0.3.x 期间提供一次性脚本，按 `preflight → plugins → backends → config → restart`
   执行；插件升级用 `extensions install ... --no-setup`，后端安装用
   `extensions setup <id>`。`config` 阶段把旧平台配置/密钥迁到
   `extensions.<plugin-id>`。0.4.x 起删除整个 `scripts/migrations/`。`--dry-run` / `--resume` / `--rollback` /
   `--rollback-on-failure` / `--continue-on-error` / `--plugin` / `--jsonl` 等行为以脚本
   的 README 为准。

## 后果（Consequences）

正面：

- 新增后端不再需要改网关核心；插件仓库可以同时交付入口、manifest、setup 与后端。
- `data/extensions` 与 `data/extension-data` 分离后，插件更新不丢后端与用户数据。
- 旧安装名通过 `aliases` 平滑过渡，旧目录只读保留，迁移失败可回退。
- setup 的幂等边界明确（action/backends/paths/config/backendState），可重跑、可脚本化。
- `list` 能直接看到后端安装状态，不需要执行插件代码。

代价与风险：

- 插件作者要自己实现下载、校验、解压、进程管理；错误处理质量直接影响安装体验。
- setup 子进程不是沙箱，插件拥有用户权限；信任模型没有变，仍需只安装可信来源。
- 后端状态由插件写入 `backends.json`，核心只能做归一化展示，不能保证插件报告真实。
- 旧的 `scripts/backends` 与 `data/backends` 还要在 0.3.x 保留一段时间，存在两套路径
  并存的认知成本。
- `update` action 目前是契约预留，CLI 升级插件时仍传 `install`；插件不能假设收到
  `update` 就代表“一定是从旧版本升级”。

## 替代方案（Alternatives）

- **继续由核心维护后端名单与安装脚本**：实现简单，但新增后端必须改核心，第三方插件
  无法自交付；与插件独立仓库的方向冲突，未采用。
- **在 manifest 里写下载 URL / 版本 / 安装命令**：核心要理解平台、压缩格式、校验与
  配置写入，manifest 会演变成小型包管理器；插件私有迁移逻辑仍无法表达，未采用。
- **使用 npm `postinstall` 或插件自带独立安装脚本**：CLI 无法统一超时、日志、错误与
  状态展示，也难以约束写入边界；仍可作为插件内部实现细节，但不是契约，未采用。
- **把 setup 放进安全沙箱**：需要跨平台权限模型与系统调用过滤，成本远超 P1 目标；
  当前明确“不是沙箱”，只做崩溃隔离、超时与写入路径检查。
- **直接删除 `data/backends` 并强制一次性迁移**：升级风险高，回滚困难，不符合 0.3.x
  兼容目标；改为只读迁移源，0.4.x 再收尾。

## 过渡与收尾

- **0.3.x**：`api_version: 2` + `backends` + `setup` 可用；`asg plugins` 仍可解析旧名并
  回退旧安装器；迁移脚本的 `config` 阶段为空操作；旧 `data/backends` 保留。
- **后续版本**：按需补迁移脚本的 `config` 阶段（旧配置键/密钥迁移），不改变本文的
  setup/CLI 契约。
- **0.4.x**：删除 `scripts/migrations/` 与旧的 `scripts/backends` 回退路径；`data/backends`
  不再作为默认迁移源（是否清理由用户决定，不由 CLI 静默删除）。

本文不声称 config 迁移或 0.4.x 清理已经完成；这些是后续阶段的明确边界。
