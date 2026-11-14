# Changelog

本项目遵循语义化版本，条目按版本倒序。

## [0.3.0] - 2026-11-14

### Added

- `asg` CLI：统一管理入口，覆盖 `status` / `start` / `stop` / `restart` / `serve` / `logs` / `config` / `engines` / `plugins` / `browser` / `adlist` / `update` / `doctor`。
- 稳定入口 `bin/asg.mjs`；systemd / launchd / 登录计划任务统一执行 `asg serve`。
- `asg status` 探测三个服务；`--json` / `--jsonl` 输出契约见 `docs/cli-contract.md`。
- `asg engines` 统一展示 searxng 引擎与网关原生源（`tracemoe` / `saucenao` / `baidu`）。
- `asg config` 用临时文件跑 `loadSettings()` 校验，写入前备份 `.bak`。

### Changed

- **破坏性变更：0.3.0 起必须重新安装**；旧的 `gateway.sh` / `gateway.ps1` / `start-all.*` / 后端壳 / 自更新壳已删除，不提供兼容层。
- 生命周期单位改为整栈：只提供 `start` / `stop` / `restart`，不再支持单组件重启。
- `--searxng-mode auto` 默认改为 `native`；Docker 模式仅保留给显式指定。
- 日志统一写入 `data/logs/<service>.log`，`asg logs` 默认合并 gateway + supervisor。
- 改配置 / 引擎 / 广告列表后整栈重启，MCP 连接会断开。

### Fixed

- `/health` 与 MCP `initialize` 返回的版本号不再硬编码 `0.1.0`，改为读取 `version.json` / `package.json`。
- `backends/cli.mjs` 支持 `--root`，安装版不再把插件写进版本目录。
- systemd 单元的 `WorkingDirectory` 不再加引号（否则 systemd 报 `bad unit file setting`，服务无法启动）。
- 安装器补齐 `data/installed.json`，`asg update check` 不再把已安装版本误判为“未安装”。
- 自更新脚本按安装布局向上查找安装根，修复安装版下读写错误 `data/` 的问题。
- FlareSolverr 增加启动自检：官方二进制在当前系统无法启动时自动关闭该能力，安装继续，不再让整栈启动失败。
- `asg adlist update`、`asg update`、`asg plugins install` 在代理环境下改用系统 curl，修复 Node fetch 不读取 `HTTPS_PROXY` 导致的下载失败。
- `asg update check` 返回 `current_version` / `up_to_date` / 目标版本；本地版本不低于远端时不再提示“有可用更新”。
- 正常参数错误与校验失败不再打印堆栈；`/health` 中成功项不再附带 `error: HTTP 200`，连接失败附带 `ECONNREFUSED` 等错误码。
- `asg doctor` 在 `flaresolverr.enabled=false` 时不再因 FlareSolverr 不可达而告警。

## [0.2.3] - 2026-11-10

### Fixed

- Windows 安装包改用 `pwsh` 的 `Compress-Archive` 生成标准 zip（`/` 分隔），避免 `Expand-Archive` 报“找不到中央目录结尾记录”。
- 完整包补上原生 searxng 安装所需资源：`docker/searxng/settings.template.yml`、`docker/searxng/quota.config.json`、`searxng-ext` 自定义引擎与 quota 插件。
- `self-update` 在 Windows 上优先使用 `Expand-Archive`，兼容旧版本包里的反斜杠条目。

## [0.2.2] - 2026-11-10

### Fixed

- 修复 Windows 安装包实际为 tar 归档的问题；改为 `Compress-Archive` 生成真正的 zip。
- `install.ps1` 增加 zip 文件头校验（`PK`），避免坏包进入解压流程。

## [0.2.1] - 2026-11-10

### Fixed

- `install.ps1` 兼容 `irm ... | iex`：移除 UTF-8 BOM 与 `param(...)` 块，改用 `$args` 解析参数。
- 用 `throw` / `return` 替代 `exit`，避免关闭用户的 PowerShell 会话。

## [0.2.0] - 2026-11-10

### Added

- 一键安装器：`scripts/install.sh`（Linux/macOS）与 `scripts/install.ps1`（Windows），支持 `curl | bash` / `irm | iex`。
- 跨平台依赖安装：searxng（Docker 或原生）、FlareSolverr、Playwright chromium。
- Windows 原生 searxng 的 `pwd` 补丁与 `searxng-ext` 集成。
- `scripts/start-all.mjs` supervisor 与 systemd/launchd/登录计划任务用户级自启。
- `runtime/pins.json` + CI `runtime.json`：依赖版本随网关发布固定。
- 自更新联动：依赖变化时 `--deps-only`，切换版本后 `--launch-only` 刷新启动清单。
