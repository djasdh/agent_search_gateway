# asg CLI 契约

- 状态：已实现（0.4.1）
- 目标版本：0.3.0
- 适用范围：安装完成后的运行期管理，以及只读的数据面冒烟测试
- 相关：ADR-0018（CLI 控制面）、ADR-0019（GUI 只调 CLI）、ADR-0022（插件自管后端与 setup 钩子）

## 0. 一句话

`asg` 负责控制面：**探测三个服务、整栈启停、写配置文件后整栈重启**。

另外提供两个只读的数据面冒烟命令 `asg search` / `asg fetch`：它们只是运行中网关的 MCP 客户端，用来验证搜索、抓取、插件和当前配置；CLI 不重新实现数据面，也不因这两个命令写配置或重启服务。

不持有运行时状态，不做单组件重启，不支持 Docker；安装根不读环境变量（`env:` 密钥引用由运行期解析）。

安装本身仍由 `scripts/install.sh` / `scripts/install.ps1` 负责；CLI 在安装完成后才存在。

## 1. 入口与安装根

### 1.1 稳定入口

```text
$ROOT/bin/asg.mjs          # 约 10 行，安装器从完整包复制一次，之后永不改变
```

职责只有四条：

1. `ROOT = 自身目录的上一级`；
2. 读 `data/current/dist/cli/asg.js`（符号链接优先），不存在则读 `data/current.json` 的 `dir`；
3. 用当前 Node 执行该入口，在未显式提供 `--root` 时补上 `--root <ROOT>`；
4. 透传 stdio，用子进程退出码退出。

不含任何业务逻辑，不判断平台，不解析配置。

服务管理器、桌面 GUI、脚本统一指向这个文件：

```ini
# systemd --user
ExecStart=<ROOT>/data/toolchain/node/bin/node <ROOT>/bin/asg.mjs serve
```

```text
# macOS LaunchAgent
ProgramArguments = [ <node>, <ROOT>/bin/asg.mjs, serve ]

# Windows 计划任务
node.exe <ROOT>\bin\asg.mjs serve
```

因此 `asg update` 切换 `data/current` 后，服务管理器不需要改写。

### 1.2 根解析顺序

```text
1. --root <dir>
2. bin/asg.mjs 传入的根
3. 从 CLI 文件位置向上，第一个含 gateway.yaml 的目录
4. process.cwd()
```

不使用环境变量。直接执行 `node data/current/dist/cli/asg.js` 也支持，走第 3、4 条。

## 2. 服务模型

服务名固定为三个（端口为默认值，实际以 `gateway.yaml` 为准）：

| 服务 | 健康地址 | 启动方式 | 日志 |
|---|---|---|---|
| `searxng` | `http://127.0.0.1:8888/healthz` | 原生进程（granian） | `data/logs/searxng.log` |
| `flaresolverr` | `http://127.0.0.1:8192/` | 官方二进制 | `data/logs/flaresolverr.log` |
| `gateway` | `http://127.0.0.1:3000/health` | `node dist/index.js` | `data/logs/gateway.log` |

端口和 URL 只从 `gateway.yaml` 读取（`gateway.port`、`searxng.url`、`flaresolverr.url`）。

**生命周期单位是整栈**：不存在 `stop searxng`、`restart gateway` 这类单组件操作。Chromium 由 gateway 懒加载，不算服务。

## 3. 启停契约

### 3.1 已注册服务管理器

服务管理器**按安装根匹配**：只有 unit / plist / 计划任务的 `WorkingDirectory`（Windows 为任务命令里的 `bin/asg.mjs` 路径）指向当前 root 时，才使用服务管理器；同名服务属于其他安装根时回退到 pid 模式。安装器也不会覆盖其他安装根已注册的自启项。

| 平台 | start | stop | restart |
|---|---|---|---|
| Linux | `systemctl --user start agent-search-gateway` | `systemctl --user stop …` | `systemctl --user restart …` |
| macOS | `launchctl kickstart gui/<uid>/com.djasdh.agent-search-gateway` | `launchctl bootout gui/<uid> <plist>` | `launchctl kickstart -k gui/<uid>/com.djasdh.agent-search-gateway` |
| Windows | `schtasks /run /tn AgentSearchGateway` | `schtasks /end /tn AgentSearchGateway` | `/end` 后 `/run` |

### 3.2 未注册服务管理器

```text
asg start    → 以 detached 方式启动 bin/asg.mjs serve，等待 pid 文件 + gateway 健康
asg stop     → 读 data/runtime/supervisor.pid，SIGTERM；超时后强杀
asg restart  → stop + start
```

`data/runtime/supervisor.pid` 由 `asg serve` 自己写入和删除，CLI 不维护其他状态文件。

### 3.3 asg serve

`asg serve` 是唯一的 supervisor，语义保持不变（原 `start-all.mjs`）：

1. 读 `data/runtime/launch.json`，按 `services` 顺序启动；
2. 每个服务启动后轮询健康，默认超时 120 秒；
3. 子进程输出统一写入 `data/logs/<service>.log`，每行格式：

   ```text
   2026-11-13T06:00:00.123Z [gateway] <原始行>
   2026-11-13T06:00:00.124Z [supervisor] 全部服务已就绪
   ```
4. 必需服务失败或退出 → 停止其余服务 → 非 0 退出，交给服务管理器重启；可选服务失败时记录原因并继续监督其余服务；
5. 收到 SIGINT / SIGTERM → 逆序优雅停止，超时强杀进程树。

### 3.4 幂等性

| 情况 | 结果 |
|---|---|
| `start` 时栈已健康 | `ok:true`，`data.state:"already_running"`，退出码 0 |
| `stop` 时栈未运行 | `ok:true`，`data.state:"already_stopped"`，退出码 0 |
| `restart` 时栈未运行 | 等同 `start` |

### 3.5 logs 契约

```text
asg logs                     # gateway + supervisor，合并按时间排序
asg logs gateway             # 单文件
asg logs all                 # 四个文件合并
asg logs gateway supervisor  # 指定多个
asg logs -f                  # 只流式输出新增行
asg logs -f --jsonl          # 每行一个 event
```

- 默认读每个文件末尾 200 行，合并后按行首 ISO 时间戳稳定排序；
- 缺失时间戳的行附到上一条之后，不单独参与排序；
- `-f` 记录每个文件的字节偏移，每 500ms 读增量，200ms 小窗排序后输出，不重复历史；
- `-f` 与 `--json` 互斥（退出码 2），流式只能用 `--jsonl`；
- `--jsonl` 事件：

  ```json
  {"type":"event","event":"log","service":"gateway","at":"...","line":"..."}
  ```

## 4. status 与只读数据面

### 4.1 探测规则

```text
gateway 可访问 → GET /health，一次取得 gateway / searxng / flaresolverr 三项
gateway 不可访问 → 直接探 searxng /healthz 与 flaresolverr /
```

每个探针超时 2 秒，并发执行。`status` 只做现场探测，不读、不写状态文件。

### 4.2 输出

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "status",
  "data": {
    "services": {
      "gateway": {
        "up": true,
        "latency_ms": 8,
        "version": "0.3.0",
        "uptime_s": 123
      },
      "searxng": { "up": true, "latency_ms": 4 },
      "flaresolverr": { "up": false, "error": "ECONNREFUSED" }
    },
    "supervisor": {
      "managed": true,
      "mode": "systemd",
      "active": true
    }
  }
}
```

字段约束：

- `services` 三个键固定存在，永远不省略；
- `up` 是布尔；`down` 时只保证 `error` 存在；
- `version` / `uptime_s` 仅 `gateway` 提供；
- `supervisor.mode` ∈ `systemd | launchd | schtasks | pid | none`；
- `supervisor.active` 来自平台命令或 pid 文件，不落盘。

`status` 是报告而不是断言：即使三个服务全部 down，`ok` 仍为 `true`，存活信息只体现在 `data.services`。只有找不到安装根或 `current` 时才返回 `ok:false`。

`--json` 之外的默认输出为人类可读表格，格式不承诺稳定。

### 4.3 search / fetch 冒烟

```text
asg search [query] [--categories <a,b>] [--engines <a,b>] [--language <code>]
           [--safesearch 0|1|2] [--num-results <n>] [--fanout 1-4]
           [--min-score 0-1] [--image-path <文件>] [--timeout <秒>]
asg fetch <url> [--max-chars <n>] [--render auto|always|never] [--timeout <秒>]
```

- 两个命令只读：以 MCP 客户端调用运行中网关的 `/mcp`，不写配置、不重启服务。
- endpoint 由 `gateway.host` / `gateway.port` 得到；`0.0.0.0` / `::` 自动换成本机地址。
- token 取 `secrets.gateway.token`，环境变量 `GATEWAY_TOKEN` 可覆盖；401/403 报 `GATEWAY_UNAUTHORIZED`。
- 参数直接映射 MCP 工具参数：`--categories` → `categories`，`--num-results` → `num_results`，`--image-path` → `image_path`（转为绝对路径），`--max-chars` → `max_chars`，`--render` → `render`（`auto` 默认 / `always` 强制浏览器 / `never` 关闭）。
- `fetch` 的 `--json` 结果额外带 `render` 字段，表示本次请求的渲染模式。
- `query` 可以省略：用于 `--categories weibo_hot` 或 `--image-path`；其余情况建议显式给出。
- `--timeout` 默认 120 秒；`--` 之后的 token 一律当作 query/URL，不按选项解析。
- 人类模式 stdout 原样输出 MCP 返回的 markdown；诊断信息走 stderr。
- 成功时 `--json` 的 `data`：

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "search",
  "data": {
    "tool": "search",
    "endpoint": "http://127.0.0.1:3000/mcp",
    "elapsed_ms": 842,
    "ok": true,
    "code": null,
    "text": "# Search: ..."
  }
}
```

- 搜索/抓取本身失败时仍保留网关返回的完整文本，错误码原样透传，退出码 1：

```json
{
  "schema_version": 1,
  "ok": false,
  "command": "fetch",
  "data": {
    "tool": "fetch",
    "endpoint": "http://127.0.0.1:3000/mcp",
    "elapsed_ms": 1500,
    "ok": false,
    "code": "FETCH_BLOCKED",
    "text": "[FETCH_BLOCKED] 抓取失败..."
  },
  "error": {
    "code": "FETCH_BLOCKED",
    "message": "抓取失败..."
  }
}
```

- 网关未启动：`SERVICE_DOWN`，退出码 1；token 错误：`GATEWAY_UNAUTHORIZED`，退出码 1。
- 参数错误（缺 URL、非法范围、未知选项）：`UNEXPECTED`，退出码 2。

## 5. 配置写入契约

### 5.1 真值就是文件

不设第二份“启用状态”。每个开关只属于一个文件：

| 操作 | 文件 |
|---|---|
| 端口、searxng URL、FlareSolverr 开关、浏览器开关 | `gateway.yaml` |
| 搜索引擎启用/禁用 | `data/deps/searxng/settings.yml` |
| 引擎路由策略（resident / rotating） | `gateway.yaml` |
| 通用上游启用/禁用 | `gateway.yaml` → `search.deepseek.enabled` |
| 扩展引擎路由覆盖 | `gateway.yaml` → `extensions.<engineId>.routing` |
| 扩展插件私有配置 | `gateway.yaml` → `extensions.<manifest id>.config` |
| 扩展密钥 | `secrets.yaml` → `extensions.<manifest id>.<name>` |
| 插件后端安装状态 | `data/extension-data/<id>/backends.json`（由插件 setup 写入） |
| 插件私有数据 | `data/extension-data/<id>/`（更新插件不覆盖） |
| 插件命令 | `gateway.yaml` |
| 广告过滤 level | `gateway.yaml` |

### 5.2 值语法

```text
asg config get gateway.port
asg config get --all                 # 整份配置，secrets 掩码
asg config set gateway.port 3100
asg config set search.reverse_image.sources '["tracemoe","baidu"]'
asg config set flaresolverr.enabled false
asg config set secrets.gateway.token --stdin
asg config validate
```

- 值先尝试 `JSON.parse`，失败按字符串处理；
- `--string` 强制字符串；
- secrets 只从 stdin 读，不进 argv；读取时只返回 `"set"` / `"unset"`。

### 5.3 校验与写入流程

不复制校验逻辑，直接复用 `loadSettings()`：

```text
1. 读 YAML Document（保留注释）
2. 改目标路径
3. 序列化到临时文件
4. 用临时文件跑 loadSettings（schema + 迁移检查）
5. 通过 → 备份 <file>.bak → rename 原子替换
6. 整栈重启 → 轮询 gateway /health
```

- 校验失败：不写文件，退出码 4，错误码 `CONFIG_INVALID`；
- 写入失败：临时文件清理，原文件不变；
- 重启或健康检查失败：保留 `.bak`，返回 `START_FAILED` / `HEALTH_TIMEOUT`，**不自动回滚**。

### 5.4 返回

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "config.set",
  "data": {
    "changed": ["gateway.port"],
    "restart": "all",
    "restarted": true
  }
}
```

整栈重启会断开 MCP 连接。人类输出必须显式提示这一点，不允许静默重启。

### 5.5 引擎

引擎在用户层只有一套命令，行内用 `id` / `group` / `kind` 区分来源：

```text
asg engines list
asg engines list --all
asg engines enable <name|group:name...>
asg engines disable <name|group:name...>

asg engines route <engine> resident|rotating|none
asg engines route <engine> --category <name> [--hot-category <name>]
asg engines route <engine> --clear

asg engines secret <engine> [--name <name>] --stdin
asg engines secret <engine> [--name <name>] --clear
```

| group | kind | 存储 |
|---|---|---|
| `searxng` | `searxng` | `data/deps/searxng/settings.yml` → `engines[].disabled` |
| `gateway.reverse_image` | `gateway` | `gateway.yaml` → `search.reverse_image.sources` |
| `gateway.search` | `gateway` | `gateway.yaml` → `extensions.<engineId>.routing`；扩展源开关按 provider 的 `enabledPathV2`（0.4.0+）或 `enabledPath`（0.3.x）写入 |
| `gateway.upstream` | `gateway` | `gateway.yaml` → `search.deepseek.enabled` |

第一版网关原生以图搜图源固定为 `tracemoe`、`saucenao`、`baidu`；文本源为 `weibo`；
通用上游为 `deepseek`。

- 每条记录的 `id` 固定为 `${group}:${name}`，`group` 表示它归哪个存储适配器管理；
- `list` 只读本地文件，离线可用；`list --all` 叠加 searxng `/config` 全量列表，searxng 不在线时报 `BACKEND_DOWN`（退出码 1）；
- `enable/disable` 支持限定名 `searxng:google`、`gateway.reverse_image:baidu`、`gateway.search:weibo`、`gateway.upstream:deepseek`；裸名（如 `google`）只在唯一命中时生效，命中多个 group 时报 `ENGINE_AMBIGUOUS`（退出码 4，`details.engines` 给出候选 id）；
- `enable/disable` 时本地不存在、但属于 searxng 默认引擎的名字，在线时通过 `/config` 校验后追加最小覆盖项；searxng 不在线则按 `ENGINE_NOT_FOUND` 处理；
- `gateway.*` 组不做远端兜底：本地没有就是 `ENGINE_NOT_FOUND`；
- `route` / `secret` 一次只接受一个引擎，同样支持 `group:name` 与唯一裸名；
- `route` 按 group 分流：
  - `searxng`：只接受位置参数 `resident` / `rotating` / `none`，写 `gateway.yaml` 的 `search.engines.resident` / `search.engines.rotating`（两个列表互斥）；
  - `gateway.search`：只接受 `--category` / `--hot-category` / `--clear`，写 `extensions.<engineId>.routing.category` / `.hot_category`；`--clear` 删除 `routing`，回退插件默认；
  - `gateway.reverse_image`：不支持路由，报 `ENGINE_NO_ROUTING`（退出码 4），用 `enable` / `disable` 控制 `search.reverse_image.sources`；
  - `gateway.upstream`：不支持路由，报 `ENGINE_NO_ROUTING`（退出码 4），用 `enable` / `disable` 控制 `search.deepseek.enabled`；
- `secret` 从引擎 `requires` 推导密钥路径：
  - `secrets.a.b` → 内置密钥，写 `secrets.yaml` 的 `a.b`；
  - `secret:<name>` → 扩展密钥，写 `secrets.yaml` 的 `extensions.<manifest id>.<name>`
    （`asg extensions secret` 与 `asg engines secret` 写同一个键，见 5.6.1）；
  - 只有一个可写依赖时可省略 `--name`；多个依赖必须给 `--name`，否则 `ENGINE_SECRET_AMBIGUOUS`（退出码 4）；`--name` 接受完整路径、完整 `secret:name` 或末段短名；
  - 值只从 stdin 读（`--stdin`），不接受位置参数；末尾一个换行会被去掉，空值报错；
  - `--clear` 删除对应路径；引擎没有密钥依赖且未给 `--name` 报 `ENGINE_NO_SECRET`，未知 `--name` 报 `MISSING_SECRET`（均为退出码 4）；
- `route` / `secret` 只写一个文件，成功后整栈重启一次；人类输出会提示 MCP 连接会断开；
- 缺 secret 的引擎 `enable` 直接拒绝：`MISSING_SECRET`，退出码 4；
- 扩展搜索源可以把启用开关声明为 `config:extensions.<id>.config.enabled`；为 `false`/缺失时 `enable` 报 `MISSING_DEPENDENCY`，退出码 4；引擎命令不改扩展私有配置；
- 批量启用/禁用全有或全无：先全部校验，任一不可用则一个文件都不写；
- 一次命令涉及两个文件时，先全部写完，再整栈重启一次；写入失败会恢复已写文件；
- 未知引擎名：`ENGINE_NOT_FOUND`，退出码 4；
- `search.reverse_image.enabled` 是能力总开关，归 `asg config`，不是引擎。

```json
{
  "id": "gateway.reverse_image:saucenao",
  "group": "gateway.reverse_image",
  "name": "saucenao",
  "kind": "gateway",
  "enabled": false,
  "available": false,
  "routing": ["source"],
  "requires": ["secrets.search.reverse_image.saucenao.api_key"]
}
```

微博记录的 `routing` 会显示文本类别：

```json
{
  "id": "gateway.search:weibo",
  "group": "gateway.search",
  "name": "weibo",
  "kind": "gateway",
  "enabled": false,
  "available": false,
  "routing": ["category:weibo", "category:weibo_hot"],
  "requires": ["config:extensions.weibo.config.enabled"]
}
```

通用上游记录的 `routing` 只有 `general`：

```json
{
  "id": "gateway.upstream:deepseek",
  "group": "gateway.upstream",
  "name": "deepseek",
  "kind": "gateway",
  "enabled": false,
  "available": false,
  "routing": ["general"],
  "requires": ["secrets.search.deepseek.api_key"]
}
```

`asg engines secret gateway.upstream:deepseek --stdin` 会写
`secrets.yaml → search.deepseek.api_key`；也可以用环境变量 `DEEPSEEK_API_KEY` 覆盖。
`gateway.upstream` 组只支持 `list` / `enable` / `disable` / `secret`，不支持 `route`。

`extensions` 段按完整 engineId 保存用户覆盖，例如：

```yaml
extensions:
  "gateway.search:weibo":
    routing:
      category: news
      hot_category: news_hot
```

```yaml
# secrets.yaml
extensions:
  "gateway.search:weibo":
    cookie: env:WEIBO_COOKIE
```

```json
{
  "engine": "gateway.search:weibo",
  "routing": ["category:news", "category:news_hot"],
  "changed": [
    "extensions.gateway.search:weibo.routing.category",
    "extensions.gateway.search:weibo.routing.hot_category"
  ],
  "restart": "all",
  "restarted": true
}
```

```json
{
  "engine": "gateway.reverse_image:saucenao",
  "secret": "secrets.search.reverse_image.saucenao.api_key",
  "changed": ["secrets.search.reverse_image.saucenao.api_key"],
  "restart": "all",
  "restarted": true
}
```

网关原生引擎的元数据与运行期实现由 `src/engines/registry.ts` 的 provider 注册表提供；新增源只需加 provider 文件与注册行，不改 CLI 层。

### 5.6 插件后端（0.4.1 起已删除）

> **0.4.1 变更**：`asg plugins`、`scripts/backends/` 与 `data/backends` 默认读取已删除。
> 后端由插件自己安装（manifest `backends` + `setup`，见 `docs/extensions.md` 与
> ADR-0022）；请使用 `asg extensions install/setup/remove`。

旧命令的解析顺序（仅 0.3.11–0.4.0 存在）不再保留：

1. `asg plugins list` / `install` / `remove` 已从 CLI 移除，调用会得到未知命令；
2. `data/backends/<name>/` 不再被 `asg extensions list` 或运行时读取；
3. 需要后端时，安装声明了 `backends` 的扩展，并用 `asg extensions setup <id>` 执行。

### 5.6.1 第三方扩展

```text
asg extensions search [query] [--limit N]
asg extensions install <owner/repo>[@version] [--backend <id>]... [--no-setup]
asg extensions setup <id> [--backend <id>]... [--status] [--uninstall]
asg extensions list
asg extensions remove <id> [--keep-data] [--force]
asg extensions config <id> [--get [key]] [--set key=value]... [--unset key]... [--file <path>] [--describe]
asg extensions secret <id> --name <name> --stdin | --clear
```

- manifest 固定为 `asg-extension.json`（`api_version: 2`）；0.4.0 不再接受或回退
  `asg-plugin.json`。
- V2 字段：`backends` / `fetch_channels` / `search_engines`；V1 manifest 不会被加载。
- 本版本仍按类型、必填项和路径安全校验；未知字段忽略。
- V2 的 `fetch_channels` 派生 platform，`search_engines` 补展示名，`backends` 注入
  `ctx.pluginBackends`。
- 安装包为单文件 ESM：Release 资产包含 `asg-extension.json`、`entry` 指向的文件与
  `SHA256SUMS`；入口可以额外导出 `setup(ctx)`。
- 安装目录 `<ROOT>/data/extensions/<id>/`，目录存在即视为已安装；插件可写数据在
  `<ROOT>/data/extension-data/<id>/`，更新插件不会覆盖。`data/backends` 是 0.3.x 旧目录，
  0.4.1 起不再读取，CLI 也不会删除。
- 官方 id（`bilibili` / `weibo` / `cnki`）与普通第三方 id 一样安装/卸载。
- `install` 默认执行 manifest 声明的全部后端 setup；`--backend <id>` 可重复，只执行指定后端；
  `--no-setup` 跳过执行但仍报告后端。给未声明后端的插件传 `--backend`，或 id 不在
  manifest 中，报 `CONFIG_INVALID`（退出码 4）。
- setup 失败时插件保留，报 `PLUGIN_FAILED`（退出码 1），可修复后运行
  `asg extensions setup <id>` 重试。
- `setup` 默认 `action=install`；`--status` / `--uninstall` 切换 action，两者互斥；
  插件没有声明后端时报 `CONFIG_INVALID`。
- `remove` 默认先执行全部后端的 `uninstall` setup，失败则不删除插件目录；
  `--force` 跳过 setup（manifest 损坏时也可用）。删除插件目录后默认删除
  `data/extension-data/<id>`，`--keep-data` 保留。
- `install` / `setup` / `remove` **不会自动重启**；需要重启网关（`asg restart`）
  或下次运行 `asg engines` 时生效。
- `list` 表格列为 `ID / VERSION / PROVIDES / BACKENDS / CHANNELS / ENGINES / ENTRY`；
  `BACKENDS` 渲染为 `<id>@<version>` / `<id>` / `<id>(未安装)`，无后端显示 `-`；
  `CHANNELS` / `ENGINES` 输出 manifest 的 `fetch_channels` / `search_engines`；0.4.0
  不再有 V1 条目。读取
  `data/extension-data/<id>/backends.json`，不执行插件代码；状态文件损坏只告警。
- `config` 读写 `gateway.yaml → extensions.<id>.config`；`id` 是 manifest id，不是 engineId；
  `<id>` 必须指向已安装插件（未安装报 `PLUGIN_UNKNOWN`，manifest 损坏报 `PLUGIN_FAILED`）：
  - 无参数：输出补齐默认值后的完整配置；
  - `--get [key]`：取单个字段，支持 `retry.times` 这类点号路径；
  - `--set key=value` / `--unset key`：都可重复，按书写顺序应用，支持嵌套键；
  - `--file <path>`：用 YAML/JSON 文件整体替换，不能与 `--set` / `--unset` 同用；
  - `--describe`：列出 `config_schema` 的顶层字段（类型、必填、默认值、说明）；
- `config` 写前用插件自己的 `config_schema` 校验；失败返回 `CONFIG_INVALID`（退出码 4），
  **不写文件、不重启**，原文件保持不变；
- `config` 写入成功后整栈重启一次；`changed` 只记录真实变化的路径，默认值不落盘；
- `secret` 写/删 `secrets.yaml → extensions.<id>.<name>`，值只从 stdin 读，末尾一个换行会被去掉；
  空值、非法名称（要求 `[a-z][a-z0-9_-]*`）报用法错误；`secrets.yaml` 权限固定 `0600`；
- `secret` 输出不回显明文；写入后整栈重启一次；
- 运行时加载与 setup 契约见 `docs/extensions.md`。

`extensions list --json` 的后端条目示例：

```json
{
  "extensions": [
    {
      "id": "example-plugin",
      "version": "0.2.0",
      "provides": ["fetch", "search"],
      "entry": "index.mjs",
      "path": "/path/to/root/data/extensions/example-plugin",
      "fetch_channels": [
        {
          "id": "example:cli",
          "name": "Example CLI",
          "backends": ["example-api"]
        }
      ],
      "search_engines": [
        {
          "id": "gateway.search:example",
          "name": "Example Search"
        }
      ],
      "backends": [
        {
          "id": "example-api",
          "name": "Example API",
          "aliases": ["example-service"],
          "installed": true,
          "enabled": true,
          "version": "1.2.3",
          "path": "/path/to/root/data/extension-data/example-plugin/backends/example-api"
        },
        {
          "id": "example-cli",
          "name": "Example CLI",
          "installed": false,
          "enabled": false
        }
      ]
    }
  ]
}
```

`extensions setup --json` 的 `data` 形如：

```json
{
  "id": "example-plugin",
  "action": "install",
  "backends": ["example-api", "example-cli"],
  "ok": true,
  "result": { "installed": true },
  "setup": {
    "attempted": true,
    "ok": true,
    "action": "install",
    "backends": ["example-api", "example-cli"],
    "result": { "installed": true }
  }
}
```

读取 / 描述示例：

```json
{
  "id": "demo-fetch",
  "config": {
    "base_url": "https://example.test",
    "enabled": true,
    "limit": 10
  },
  "valid": true
}
```

```json
{
  "id": "demo-fetch",
  "fields": [
    {
      "key": "enabled",
      "type": "boolean",
      "required": false,
      "default": true,
      "description": "总开关"
    }
  ]
}
```

写入示例：

```json
{
  "id": "demo-fetch",
  "config": {
    "base_url": "https://example.test",
    "enabled": true,
    "limit": 20
  },
  "changed": ["extensions.demo-fetch.config.limit"],
  "restart": "all",
  "restarted": true
}
```

```json
{
  "id": "demo-fetch",
  "name": "api_key",
  "changed": ["secrets.extensions.demo-fetch.api_key"],
  "restart": "all",
  "restarted": true
}
```

### 5.7 浏览器

```text
asg browser status
asg browser install            # 只装 headless shell
asg browser install --full     # 完整 Chromium（含 shell）
```

- `status` 只查 Playwright 缓存目录（Linux `~/.cache/ms-playwright`、macOS `~/Library/Caches/ms-playwright`、Windows `%LOCALAPPDATA%\ms-playwright`）；
- `install` 调用当前 release 的 Playwright CLI；
- 浏览器懒加载，不重启服务。

### 5.8 广告列表

```text
asg adlist update [--level ads|ads+tracking|full]
```

- 不带 `--level` 时读 `gateway.yaml` 的 `ad_filter.level`；`off` 直接成功；
- 下载后原子写 `data/adblock/hosts`；
- **必须整栈重启**：网关内存里的域名过滤集只在自身调度器拉取时刷新，外部写入新文件不会触发热更新；
- 返回 `{ level, entries, path, restart, restarted }`。

### 5.9 诊断

```text
asg doctor
```

- 只读检查，不写文件、不重启；
- 输出固定为 `data.checks[]`，每项 `{ name, ok, level: "error"|"warn", code?, message? }`；
- `error` 级失败时进程退出码为 1，但 result 仍为 `ok:true`（命令本身执行成功，报告在 data 里）；
- `warn` 级失败只展示，不影响退出码。

## 6. 输出契约

### 6.1 模式

| 模式 | stdout |
|---|---|
| 默认 | 人类文本，格式不承诺 |
| `--json` | 恰好一个 result 对象 |
| `--jsonl` | 逐行 NDJSON，最后一行必须是 result |

任何模式下，诊断日志都走 stderr；stdout 不混入提示语。

### 6.2 result

```json
{ "schema_version": 1, "ok": true, "command": "status", "data": {} }
{ "schema_version": 1, "ok": false, "command": "status",
  "error": { "code": "NOT_INSTALLED", "message": "未找到 gateway.yaml" } }
```

### 6.3 event（仅长任务）

```json
{"type":"event","schema_version":1,"event":"progress","job":"update","percent":42}
{"type":"event","schema_version":1,"event":"log","service":"searxng","line":"..."}
```

### 6.4 退出码

```text
0 成功
1 运行失败（启动、健康检查、更新、search/fetch 数据面失败）
2 参数错误
3 未安装（找不到 gateway.yaml 或 data/current）
4 校验失败 / 冲突
```

### 6.5 错误码

```text
NOT_INSTALLED      未找到 gateway.yaml 或 data/current
START_FAILED       启动命令失败
HEALTH_TIMEOUT     启动后健康检查超时
CONFIG_INVALID     配置解析或校验失败
SCHEMA_MISMATCH    current.json / launch.json 结构不符
MISSING_SECRET     缺 api_key / token
MISSING_DEPENDENCY 缺配置依赖（如 weibo.enabled）
ENGINE_NOT_FOUND   引擎名不存在
ENGINE_AMBIGUOUS   裸名命中多个 group，需用 group:name 限定
ENGINE_NO_ROUTING  该引擎 group 不支持路由策略
ENGINE_NO_SECRET   引擎没有可配置的密钥依赖
ENGINE_SECRET_AMBIGUOUS 多个密钥依赖需要 --name 指定
PLUGIN_UNKNOWN     插件名不存在
PLUGIN_FAILED      插件安装/卸载失败
BACKEND_DOWN       需要后端在线但不可达
SERVICE_DOWN       gateway 不可达（status 探测、search/fetch 连接失败）
GATEWAY_UNAUTHORIZED search/fetch 的 MCP 鉴权失败（HTTP 401/403）
SEARCH_* / FETCH_* 等 search/fetch 工具返回的数据面错误码（原样透传）
DOWNLOAD_FAILED    下载失败（广告列表等）
BROWSER_NOT_INSTALLED
NODE_TOO_OLD
PYTHON_MISSING
PORT_IN_USE
SERVICE_NOT_REGISTERED
UPDATE_FAILED
UPDATE_ROLLED_BACK
```

## 7. 文件布局

| 路径 | 写入者 | 用途 |
|---|---|---|
| `bin/asg.mjs` | 安装器 | 稳定入口，永不改写 |
| `gateway.yaml` / `secrets.yaml` | CLI / 用户 | 用户配置 |
| `data/current` | 安装器 / update | 符号链接（Unix） |
| `data/current.json` | 安装器 / update | 版本指针（全平台） |
| `data/installed.json` | 安装器 / update | 自更新读取的安装状态（current / previous） |
| `data/runtime/launch.json` | 安装器 | 启动清单 |
| `data/runtime/supervisor.pid` | `asg serve` | 未注册服务时的 pid |
| `data/logs/<service>.log` | `asg serve` | 服务日志 |
| `data/deps/searxng/settings.yml` | CLI / 安装器 | searxng 配置 |
| `data/extensions/<id>/` | `asg extensions` | 已安装插件（只读；更新时整体替换） |
| `data/extension-data/<id>/` | 插件 setup | 插件可写数据；`state.json`、`backends.json`、`backends/<id>/`、`tmp/` |
| `data/extension-data/<id>/backends.json` | 插件 setup | 后端安装状态；`extensions list` 只读 |
| `data/backends/<name>/version.json` | 0.3.x 旧安装器 | 历史安装记录；0.4.1 起不再读取，可自行清理 |
| `data/migrations/0.3.x/` | 0.3.11 迁移脚本 | state/备份；0.4.1 起脚本目录已删除 |

不新增全局 `state.json`、`desired.json`、`pids.json`。插件自己的
`data/extension-data/<id>/state.json` 属于插件数据，不是 CLI 控制面状态。

## 8. 脚本去留

保留：

```text
scripts/install.sh / install.ps1        引导：Node、下载、校验、解压、切 current
scripts/install/*.mjs                   作为库被 CLI 调用
scripts/self-update/cli.mjs             作为库被 asg update 调用
scripts/install/make-runtime.mjs        CI 专用
scripts/bench*                          开发工具，不属于控制面
```

删除：

```text
scripts/start-all.mjs                   supervisor 逻辑并入 asg serve
scripts/start-all.ps1                   Windows 直接调 bin/asg.mjs
scripts/gateway.sh / gateway.ps1        被 asg 取代
scripts/backends/*.{sh,ps1,cmd}         12 个引导壳
scripts/self-update/*.{sh,cmd}          3 个引导壳
scripts/update-adlist.sh                改为 asg adlist
```

`data/backends` 在 0.4.1 起不再是迁移读取源：插件后端的新位置是
`data/extension-data/<id>/backends/<backend-id>`，由插件 `setup` 安装；旧目录不主动删除，
也不再被 CLI 读取。

## 9. 安装与升级

- 安装器不调用 `asg`：CLI 在 `data/current` 就绪后才存在。
- `--searxng-mode` 只支持 `auto | native | external`（0.3.4 起移除 Docker 分支）。
- 0.3.0 起 `asg` 是唯一管理入口，**要求重装**；不提供旧脚本兼容层。
- `runtime/pins.json` 仍是依赖版本唯一来源；CLI 不自动追最新。
- 自更新：切换 `data/current` → 整栈重启 → 健康检查 → 失败回滚到上一版本。

## 10. 非目标

- 单组件启停 / 重启；
- Docker 部署与容器编排（0.3.4 起不支持）；
- 远程管理、多用户、Web 管理台；
- `state.json` / `desired.json` / 控制 socket；
- 环境变量指定安装根；
- `asg setup`：安装仍走 `install.sh` / `install.ps1`；
- 引擎对象的统一抽象（第一版按 `kind` 分支，后续再做）。
