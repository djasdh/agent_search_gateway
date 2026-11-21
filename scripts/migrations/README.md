# 0.3.x 临时升级/迁移脚本

本目录是 **0.3.x 兼容版本的一次性过渡工具**，不进入运行时，也不属于稳定 CLI。

五段：

```
preflight -> plugins -> backends -> config -> restart
```

`config` 阶段把旧平台配置迁到 `extensions.<plugin-id>`：

- `gateway.yaml`：`bilibili` / `weibo` → `extensions.<id>.config`；
  `search.weibo` → `extensions.weibo.config.search`
- `secrets.yaml`：`bilibili.http.token` → `extensions.bilibili.token`

**0.4.0 保留本目录用于 0.3.x → 0.4.0 升级；0.4.1 删除。**

> **与插件契约的关系**：本脚本只调用公开 CLI，不 import 网关内部模块，也不属于插件
> 契约。后端由插件 `setup` 安装到 `data/extension-data/<id>/backends/<backend-id>/`；
> `data/backends` 是只读迁移源，脚本与插件都只复制、不删除。manifest / setup 契约见
> [`docs/extensions.md`](../../docs/extensions.md)，决策见
> [`docs/adr/0022-plugin-owned-backends-and-setup-hook.md`](../../docs/adr/0022-plugin-owned-backends-and-setup-hook.md)。

## 它解决什么问题

0.3.x 期间官方插件（bilibili / weibo / cnki 等）需要从旧版本升级到兼容版本，而部分插件会
在升级后通过 `asg extensions setup <id>` 安装/更新自己的后端（例如独立服务、浏览器依赖等）。
手动逐台执行容易漏步、无法续跑，也无法在失败后恢复配置与插件版本，因此提供这个脚本：

- 只升级 **已安装且命中清单** 的插件，不擅自安装未安装插件；
- 按阶段执行，state 原子落盘，可断点续跑；
- 升级前备份 `gateway.yaml` / `secrets.yaml`，可回滚；
- `--dry-run` 只输出计划，不产生副作用。

## 运行

```bash
# 1. 先看计划（不备份、不写 state、不执行命令）
node scripts/migrations/0.3.x.mjs --dry-run

# 2. 完整执行
node scripts/migrations/0.3.x.mjs --root /path/to/install

# 3. 失败后从第一个未完成阶段继续
node scripts/migrations/0.3.x.mjs --root /path/to/install --resume

# 4. 只运行某一段
node scripts/migrations/0.3.x.mjs --phase plugins
node scripts/migrations/0.3.x.mjs --phase backends
node scripts/migrations/0.3.x.mjs --phase restart --no-restart

# 5. 临时覆盖/新增一个目标（只处理已安装插件）
node scripts/migrations/0.3.x.mjs \
  --plugin weibo=djasdh/agent-search-gateway-plugin-weibo@0.2.2

# 6. 回滚配置与插件版本
node scripts/migrations/0.3.x.mjs --rollback

# 7. 机器可读输出
node scripts/migrations/0.3.x.mjs --jsonl
```

安装根解析顺序：`--root` > 从脚本位置向上查找 `gateway.yaml` > 向上查找
`data/current.json` 或 `data/current` > 当前工作目录。

完整参数：

| 参数 | 说明 |
| --- | --- |
| `--root <dir>` | 安装根 |
| `--phase <name>` | `preflight` / `plugins` / `backends` / `config` / `restart` / `all`（默认） |
| `--dry-run` | 只执行 preflight 计划，无任何写入或命令 |
| `--resume` | 从 `state.json` 第一个未完成阶段继续（仅在 `--phase all`，即默认模式时生效） |
| `--rollback` | 恢复配置备份，并按记录重装旧插件版本 |
| `--rollback-on-failure` | 任一阶段失败后自动回滚 |
| `--continue-on-error` | plugins/backends 阶段单个插件失败后继续处理其余插件；阶段最终仍记为 failed |
| `--plugin <id>=<repo>@<version>` | 覆盖清单中的目标或新增目标；可重复 |
| `--no-restart` | 跳过 restart 阶段 |
| `--jsonl` | 所有日志为 NDJSON 事件，最后一行为 `result` |
| `-h`, `--help` | 帮助 |

## 五个阶段的含义

### preflight

- 解析安装根，检查 Node.js 版本（>= 20）；
- 备份 `gateway.yaml` / `secrets.yaml` 到
  `data/migrations/0.3.x/backup-<时间>/`（文件不存在时跳过并告警）；
- 读取清单、扫描 `data/extensions/*/asg-extension.json`（V2）或 `asg-plugin.json`（V1）、生成计划；
- `--dry-run` 到此结束。

### plugins

对每个“已安装且命中清单”的插件执行：

```bash
node <root>/bin/asg.mjs extensions install <repo>@<version> --no-setup
```

然后用本地 `asg-plugin.json` 校验 `version`。已同版本则跳过；未安装的清单插件只告警，
不会安装。第三方插件（不在清单且未通过 `--plugin` 指定）跳过并告警。

### backends

重新扫描插件，对每个命中目标 **且 manifest 声明了非空 `backends`** 的已安装插件执行：

```bash
node <root>/bin/asg.mjs extensions setup <id>
```

没有 `backends` 的插件跳过。`--continue-on-error` 对 plugins/backends 的单插件循环生效。
setup 必须可重复执行：已安装的后端应被插件识别并跳过/升级，而不是重复下载；插件数据在
`data/extension-data/<id>/`，升级插件目录不会删除它。旧 `data/backends` 只读，插件应复制到
新目录而不是移动。

### config

把平台配置和密钥迁到插件私有配置：

- `gateway.yaml` 的顶层 `bilibili` / `weibo` 段 → `extensions.<id>.config`；
- `search.weibo` → `extensions.weibo.config.search`；
- `secrets.yaml` 的 `bilibili.http.token` → `extensions.bilibili.token`。

迁移使用 `yaml` 的 Document API，尽量保留注释。旧键删除后再启动，strict schema
不会因为未知字段失败。没有需要迁移的键时该阶段直接完成。

### restart

执行 `asg restart`，随后最多轮询 30 秒：

1. 优先 `node <root>/bin/asg.mjs status --json`，判断 gateway 是否 up；
2. 失败则读取 `gateway.yaml → gateway.host/port`，请求 `http://host:port/health`，
   且响应必须能解析出字符串 `gateway.version` 才算健康（仅 2xx 不算）。

`--no-restart` 时整段跳过。清单为空或清单中的插件全部未安装（没有可处理目标）时，
restart 也直接记为 `skipped`，不重启网关。

## 清单格式

`scripts/migrations/0.3.x.plugins.json`：

```json
{
  "schema": 1,
  "plugins": [
    { "id": "weibo", "repo": "djasdh/agent-search-gateway-plugin-weibo", "version": "0.2.2" }
  ]
}
```

- `schema` 目前只接受 `1`；
- 0.4.0 清单包含三个官方插件（`bilibili` / `cnki` 目标 `0.2.0`，`weibo` 目标 `0.2.2`）；第三方插件仍需通过 `--plugin` 指定；
- 官方插件 manifest 的 `backends[].aliases` 必须覆盖历史安装名、通道 ID 与别名，
  否则 `asg plugins install <旧名>` 只能回退到旧安装脚本；这是插件仓库的发版检查项；
- `--plugin <id>=<repo>@<version>` 会按 `id` 覆盖清单条目；也可以新增清单里没有的 id，
  但仍只处理已安装插件；
- 测试/应急时可用环境变量 `ASG_MIGRATION_MANIFEST` 指向另一份清单文件。

## state 与备份

```
<root>/data/migrations/0.3.x/
├── state.json                  # 原子写（临时文件 + rename）
└── backup-2026-11-16T10-37-00-000Z/
    ├── gateway.yaml
    └── secrets.yaml
```

`state.json` 的主要形状：

```json
{
  "schema": 1,
  "migration": "0.3.x",
  "root": "/path/to/install",
  "created_at": "...",
  "updated_at": "...",
  "checklist": { "path": "...", "schema": 1, "count": 1 },
  "backup": {
    "dir": ".../backup-...",
    "gateway_yaml": ".../gateway.yaml",
    "secrets_yaml": ".../secrets.yaml",
    "gateway_existed": true,
    "secrets_existed": true
  },
  "installed_before": [{ "id": "weibo", "version": "0.1.0", "backends": [] }],
  "phases": {
    "preflight": { "status": "done", "started_at": "...", "finished_at": "..." },
    "plugins": { "status": "done", "note": "1 个插件已升级" },
    "backends": { "status": "done" },
    "config": { "status": "skipped", "note": "P2 启用" },
    "restart": { "status": "done" }
  },
  "plugins": {
    "weibo": {
      "id": "weibo",
      "repo": "djasdh/agent-search-gateway-plugin-weibo",
      "from": "0.1.0",
      "to": "0.2.0",
      "status": "installed"
    }
  },
  "backends": {
    "weibo": { "id": "weibo", "status": "done", "backends": ["..."] }
  },
  "errors": [],
  "rollback": null
}
```

阶段状态：`pending` / `running` / `done` / `skipped` / `failed`。`--resume` 跳过
`done` 与 `skipped` 的阶段，从第一个其它状态继续；插件自身的 `installed` / `skipped`
记录也会避免重复安装。

## 回滚

`--rollback` 会：

1. 从 `state.backup` 恢复 `gateway.yaml` / `secrets.yaml`（缺失备份会记录为 skipped）；
2. 对 `state.plugins` 中有 `from` 记录的插件执行
   `extensions install <repo>@<from> --no-setup`，并校验版本；已经是旧版本的跳过；
3. 把结果写入 `state.rollback`。

如果 `gateway.yaml` 与 `secrets.yaml` 都没有备份，`rollback.status` 记为
`done-with-warning`，并明确提示“没有配置备份，仅回滚了插件版本（如有）”，
不会再输出“回滚完成”。

明确不负责：

- **核心版本回滚**（请使用 `asg update` / 自更新逻辑）；
- 删除 `data/extension-data` 或 `data/backends`（插件数据与后端目录按约定保留）；
- 恢复 P1 未修改过的 config 内容（P1 的 config 阶段本身是空操作）。

`--rollback-on-failure` 在阶段失败时自动执行同一套回滚。`--dry-run --rollback` 只打印
回滚计划。

## 输出与退出码

- 人类可读模式：`[migrate 0.3.x] ...`；
- `--jsonl`：每行一个 JSON 事件（`{"type":"event",...}`），最后一行为
  `{"type":"result",...}`，包含 `ok`、`phases`、`plugins`、`errors`、`state_file`、
  `backup_dir` 等字段；
- 退出码：`0` 成功；`1` 阶段失败；`2` 参数错误。

## 阶段边界

- **当前状态**：五个阶段均已实现；`config` 会迁移旧平台配置键与 bilibili 密钥。
- **0.4.0**：保留 `scripts/migrations/` 用于 0.3.x → 0.4.0 升级；`asg plugins` 与
  旧 `scripts/backends` 回退也保留为 deprecated。
- **0.4.1**：删除 `scripts/migrations/`、`asg plugins` 与旧 `scripts/backends` 回退。

## 已知限制

- **临时工具**：0.4.1 删除本目录，不做长期兼容承诺；
- 插件后端是否安装成功以 `asg extensions setup` 退出码为准，脚本不验证后端进程本身；
- 每条 `asg` 子命令默认 30 分钟超时（可用 `ASG_MIGRATION_COMMAND_TIMEOUT_MS` 覆盖，
  仅供测试/应急），超时会终止整个进程树；stdout/stderr 各保留最后 1MB；
- `state.json` 会校验 `schema` / `migration` / `root`，不能跨安装根复用；
- restart 健康检查最多 30 秒；自定义 host 为 `0.0.0.0`/`::` 时 HTTP 回退使用
  `127.0.0.1`；
- 回滚依赖 `state.json` 与备份目录，手动删除后无法恢复；
- 不处理核心版本回滚，也不清理 `data/extension-data` / `data/backends`。
