# Changelog

本项目遵循语义化版本，条目按版本倒序。

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
