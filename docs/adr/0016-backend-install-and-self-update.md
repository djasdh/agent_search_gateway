# 后端安装脚本与网关自更新

## 背景

网关依赖若干外部后端与运行时：B 站 `bili` CLI（PyPI `bili-agent`）、`yt-dlp`、微博 `OpenCLI`（npm）、B 站专栏 HTTP 服务（`bilibili-article-server`）。此前这些都靠 README 手工安装，路径靠 PATH；网关自身升级则需要 `git pull` + `npm ci` + `npm run build`，目标机器没有开发工具链时无法完成。

同时，`bilibili-article-server` 依赖 GPL-3.0 的 `bilibili-api-python`，留在主仓库会带来许可证边界问题。

## 决策

1. **一个后端一个脚本**：`scripts/backends/` 下为 `bili`、`ytdlp`、`opencli`、`article` 各提供 Linux/macOS（`.sh`）与 Windows（`.ps1` + `.cmd`）薄包装，共享 `cli.mjs`，统一支持 `install | update | status | uninstall`。
2. **安装目录固定**：后端统一装到 `data/backends/<name>/`，版本、来源与原配置值记录在同目录；`uninstall` 还原 `gateway.yaml` 并删除目录。
3. **自动写配置**：安装/更新后用 `yaml` Document API 把可执行文件绝对路径写回 `gateway.yaml`（保留注释），不再依赖 PATH。`opencli` 仅在配置已有 `weibo` 段时写入。
4. **专栏后端独立仓库**：`bilibili-article-server` 抽到 [djasdh/bilibili-article-server](https://github.com/djasdh/bilibili-article-server)（GPL-3.0-or-later），主仓库只保留 HTTP 客户端；安装脚本从其 GitHub Release 拉取固定版本源码包。
5. **一个平台一个自更新脚本**：`scripts/self-update/` 下为 Linux、macOS、Windows 各提供薄包装，共享 `cli.mjs`，从公开仓库最新正式 Release 下载对应平台的完整包。
6. **完整包**：CI 为 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`win32-x64` 构建含 `dist/` 与生产 `node_modules/` 的包，目标机器无需 npm/tsc。`sqlite-vec` 是原生模块，必须按平台真机构建。
7. **版本目录切换**：包解压到 `data/releases/<version>-<platform>/`，用 `data/current`（Linux/macOS）或 `data/current.json`（Windows）指向当前版本；`gateway.yaml`、`secrets.yaml`、`data/` 始终留在仓库根，不随版本切换。
8. **自动回滚**：更新后调用 `scripts/gateway.sh restart gateway`（Windows 为 `gateway.ps1 restart`）并轮询 `/health`；30 秒内不健康则切回上一版本并重启。
9. **无 Node 自举**：薄包装发现 PATH 里没有满足版本要求的 Node 时，下载官方 LTS 到 `data/toolchain/node/`，不要求预装开发环境。
10. **CI 只在公开仓库发布**：`.github/workflows/release.yml` 在公开仓库 push `v*` tag 时构建并发布；私有仓库同名 workflow 直接跳过。

## Consequences

- 后端安装/升级可重复执行且幂等；卸载会还原配置，不留悬空路径。
- 网关升级不再需要源码与开发依赖，但完整包体积增大（含 `node_modules`），每个平台一个资产。
- `data/` 需要持久化；`data/releases/` 只保留最近 3 个版本。
- 私有部署统一从公开 Release 更新，会带上公开分支独有的微博代码（默认关闭）；需要私有差异时应改用 `--repo` 参数或独立发布通道。
- `bilibili-article-server` 的 GPL 义务由独立仓库承担；主仓库只通过 HTTP 调用，不导入其代码。
- Windows 使用 PowerShell 5.1 包装，不依赖符号链接权限。
- `scripts/` 属于安装器，不随版本切换；自更新只切换 `dist/` 与 `node_modules/`。升级安装器需要重新拉取仓库。
