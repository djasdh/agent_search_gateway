# Changelog

本项目遵循语义化版本，条目按版本倒序。

## [Unreleased]

### Added

- 0.3.x 迁移清单补充 `bilibili` / `weibo` / `cnki` 到 `0.2.0`：已安装的官方插件可由迁移脚本自动升级到 V2 manifest。

### Fixed

- 安装器升级/重装不再覆盖已有 `gateway.yaml` 的端口、searxng/FlareSolverr 地址与启用状态，只补缺失键。
- `--launch-only` / `--deps-only` 从 `gateway.yaml` 读取实际端口写 `launch.json`，不再固定用 3000。
- `install.sh` 改为配置成功后切换 `data/current`，失败时保留旧版本；`current.json` 用 `JSON.stringify` 写绝对路径，支持含引号的目录。
- 迁移脚本写回 `secrets.yaml` 时保持 0600，`gateway.yaml` 保留原权限。

## [0.3.10] - 2026-11-21

### Fixed

- adlist 刷新改为后台进行：`createServer` 先用磁盘上现有 hosts 建过滤器并立即返回，过期时的下载不再阻塞 MCP 会话初始化（慢网下拉 2.3MB hosts 曾把 `initialize` 拖到 30–60s，触发客户端连接超时）。新增回归测试覆盖"下载悬而未决时 `initialize` 已完成"。
- 安装器：FlareSolverr 自检与启动环境会主动查找 Xvfb（`PATH` 之外还覆盖 `/usr/bin`、`/usr/local/bin`、`/opt/X11/bin`、`~/miniconda3/bin`、`~/anaconda3/bin`、`~/miniforge3/bin` 等），并把找到的目录写进 launch 环境；此前 conda 用户的 Xvfb 不在服务管理器 PATH 里，导致 FlareSolverr 被误判为不可用。
- 安装器：FlareSolverr 自检失败不再只上报 PyInstaller 的 `[PYI-…] Failed to execute script`；会优先挑出 `FileNotFoundError` / `Exception` 行，并在缺少 Xvfb 时给出 Debian/Ubuntu、Arch、Fedora 的安装命令。
- 安装器：FlareSolverr 自检改为独立进程组，结束后连同它拉起的 Xvfb / chrome 一起清理（此前只杀直接子进程，残留的 Xvfb 会让后续自检偶发卡死）；冷启动超时放宽到 120s（重试 180s），并同时收集 stdout/stderr 作为诊断。
- `asg doctor` 新增 `xvfb` 检查项（FlareSolverr 启用且为 Linux 时）：找不到 Xvfb 会告警并给出安装命令；FlareSolverr 关闭或非 Linux 平台直接跳过。


## [0.3.9] - 2026-11-21

### Added

- 插件 manifest `api_version: 2` 支持 `backends`、`fetch_channels`、`search_engines`；入口可选导出 `setup(ctx)`，由插件自行下载、校验、安装所需后端。
- 新增 `asg-extension.json`（V2 manifest）；安装器优先新文件，缺失时回退 `asg-plugin.json`。
- 实现 V2 runtime：V1/V2 同时加载；`fetch_channels` 派生 fetch platform，`search_engines` 补搜索源展示名。
- V2 声明 `backends` 时注入 `ctx.pluginBackends`（`ids` / `dir(id)` / `state(id)`），插件运行时直接使用自己安装的后端。
- `asg extensions list` 输出 `backends` / `fetch_channels` / `search_engines`，新增 CHANNELS / ENGINES 列。
- setup 宿主：独立子进程 + IPC，提供文件、https 下载、SHA256、解压、命令执行、`extensions.<id>.config`、state 与 backendState 能力。
- 插件数据目录 `data/extension-data/<id>/`，与 `data/extensions/<id>/` 分离；插件更新不再丢后端。
- `asg extensions install|setup|remove` 增加后端生命周期：默认安装全部声明后端，支持 `--backend`、`--no-setup`、`--status`、`--uninstall`、`--keep-data`、`--force`。
- 新增 0.3.x 临时迁移脚本 `scripts/migrations/0.3.x.mjs`：分段 preflight → plugins → backends → config → restart，支持 dry-run、resume、rollback 与 jsonl。
- 迁移脚本支持 V2 `asg-extension.json`；config 阶段把旧平台配置/密钥迁到 `extensions.<plugin-id>`。
- 新增 ADR-0022：插件自管后端与 setup 钩子。

### Changed

- `asg plugins` 降级为兼容 facade：按已安装 V1/V2 manifest 的 `backends[].id` / `aliases` 解析，未命中回退旧 `scripts/backends/cli.mjs`；`asg extensions` 成为推荐入口。
- `asg extensions install/setup/remove` 不自动重启网关；`config` / `secret` 写入仍整栈重启。
- 插件 `config` 写入在 setup 子进程内同样按 `config_schema` 校验，失败不落盘。

### Fixed

- 安装器：`$VAR` 紧跟全角括号会被 bash 3.2 吞进变量名并触发 `unbound variable`，统一改为 `${VAR}` 写法。
- 安装器：安装包下载会复用 SHA256 命中的缓存，残包先尝试 `curl -C -` 续传，校验失败再整包重下。
- 安装器：下载失败会列出每次尝试（fetch/curl/wget）的真实原因，不再被 `wget: spawn wget ENOENT` 覆盖；403/429 优先提示设置 `GITHUB_TOKEN`。
- `GET /health` 与 MCP `health` 共用语义层快照，embedding 启用时不再恒报 `down`。
- 网关侧搜索源鉴权失败映射为 `SEARCH_AUTH_REQUIRED`，不再混入可重试的 `SEARCH_UPSTREAM`。
- `asg plugins install opencli` 不再尝试同步微博 override（历史遗留，安装版布局下必然跳过）；override 由微博扩展接管。

## [0.3.8] - 2026-11-18

### Added

- 新增 `gateway.upstream` 引擎组与内置 `gateway.upstream:deepseek` 通用搜索上游：仅在 general 查询与 searxng 并发，支持 `raw`（Search API）与 `harness`（Messages + `deepseek_web_search`）两种模式，默认关闭。
- 多上游融合按源内名次归一化（第 1 名 1.0）、URL 去重合并、`score × engine_boost` 排序；raw 官方分只用于源内排序与 `min_score`，harness 无原始分、不参与 `min_score`。
- DeepSeek 上游失败静默降级并在结果末尾说明；启用但缺 key 或发生降级时不写缓存；searxng 与所有通用上游都失败才报错。
- `asg engines` 支持 `gateway.upstream:deepseek` 的 `list` / `enable` / `disable` / `secret`；`route` 报 `ENGINE_NO_ROUTING`。
- 新增配置 `search.deepseek`（默认 `enabled: false`、`mode: raw`）与密钥 `secrets.yaml → search.deepseek.api_key`（可用 `DEEPSEEK_API_KEY` 覆盖）。
- 新增 ADR-0023：DeepSeek 通用搜索上游。

### Changed

- ADR-0006 的「searxng 单一上游」标注为部分由 ADR-0023 修订；外部搜索基础设施仍按原方式作为 searxng 引擎接入。

## [0.3.7] - 2026-11-15

### Added

- 第三方插件私有配置：`asg-plugin.json` 可选 `config_schema`（JSON Schema 子集）声明字段、类型、默认值与必填；值存 `gateway.yaml → extensions.<manifest id>.config`，运行期注入 `ctx.pluginConfig`。
- 插件密钥新增 `secrets.yaml → extensions.<manifest id>.<name>` 键，运行期注入 `ctx.pluginSecrets`；旧 `extensions.<engineId>.<name>` 继续兼容。
- 新增 `asg extensions config`：`--get` / `--set` / `--unset` / `--file` / `--describe`，支持多字段与嵌套键。
- 新增 `asg extensions secret`：从 stdin 写插件密钥，写入 0600 的 `secrets.yaml`，不回显明文。
- 插件 skills 增加私有配置章节、字段命名规范与示例；新增 ADR-0021。

### Changed

- 插件配置字段统一 snake_case（`enabled` / `base_url` / `timeout_ms` / `limit` / `max_retries` 等）。
- `asg engines enable` 的 `secret:` 依赖检查同时识别 manifest id 与 engineId 键；扩展 `enabledPath` 可指向 `extensions.<id>.config.enabled`。
- `asg extensions config` / `secret` 写入前整体校验，成功后整栈重启；默认值只在运行期补齐，不写回配置。

### Fixed

- POST `/mcp` 收到非法 JSON 或超过 1MB 的 body 时不再永久挂起：分别返回 400 / 413 JSON-RPC 错误。
- `fetch` 的 JSON 响应原样返回，避免 64 位整数与大数精度丢失。
- `fetch` 的 HTML 清洗限定在 `body` 内，正文为空时回退 full，避免 Wikipedia 等静态页被误判为 JS 空壳。
- `browser_*` 同一 MCP 会话串行执行，避免共享 page 并发导航串台。
- `fetch` 非 2xx 使用 `FETCH_HTTP_STATUS`；304 不再误报重定向错误，204/205 返回明确的空响应。
- `fetch` 无 `Content-Type` 时嗅探文本，避免把文本响应误落盘为 `.bin`。
- `fetch` 拒绝带凭据的 URL，日志与错误文本统一脱敏；`max_chars` 成为最终硬上限。
- SSRF 拦截域名内嵌私网 IP（点分/连字符），不依赖 DNS 结果。
- `browser_*` 失败返回 `isError: true` 并清洗 ANSI；选择器操作上限 8 秒、长度上限 500 字符。
- `/health` 的 `uptimeSec` 使用进程启动时间，不再恒为 0。
- MCP 401 补 `WWW-Authenticate`、405 补 `Allow`；`DELETE /mcp` 缺 session 返回 400，未知 session 返回 404。
- 显式 `engines` 全部不可用时返回 `SEARCH_INVALID`；未知类别改为结果末尾提示，不再硬拒绝。
- `search_by_image` 且 query 不是图片 URL 时返回 `SEARCH_INVALID`，不再静默降级为普通网页搜索。
- `search` 的 query 先 trim，纯空白串与空串行为一致。
- CLI 选项缺值、单横线未知选项、重复指定都按用法错误处理。
- 清理扩展化后遗留的微博文案；微博 / B 站 / 知网能力由官方扩展提供。

## [0.3.6] - 2026-11-15

### Added

- 新增只读数据面命令 `asg search` / `asg fetch`：以 MCP 客户端调用运行中的网关，支持 `--json`（endpoint / 耗时 / 错误码 / 完整文本），不写配置、不重启服务。
- `fetch` 新增 `render: auto | always | never`（默认 `auto`）：内容判空后自动升级浏览器渲染；`always` 强制，`never` 关闭。
- `asg fetch` 新增 `--render`，`--json` 输出带本次渲染模式。
- 新增 ADR-0020：按转换后的正文判断 JS 空壳，不再看 HTML 体积。

### Changed

- MCP `search` / `fetch` 失败时返回 `isError: true`；CLI 同时兼容旧网关的 `[SEARCH_*]` / `[FETCH_*]` 前缀。
- fetch 的 JS 渲染判定改为“正文可见字符数 + script/SPA/noscript 特征”；大体积 SPA 空壳不再漏判。
- JS 空壳优先本地 playwright，失败再 FlareSolverr；CF/403 仍保持 FlareSolverr 优先。
- 误判时同时保留 direct 与渲染结果，按正文长度取更长者。
- playwright 渲染改为 `commit` + 有界 `domcontentloaded` / `networkidle` + 正文轮询；并发渲染串行化，避免共享 page 互相导航。
- `html2md` 把 `data:` URI 图片落盘为 `/files/<id>` 链接（单张 2MB、单次 10MB / 20 张），避免 base64 占满上下文或被当作正文。
- README / CLI 契约补充 search / fetch 与 render 说明；ADR-0018 增加只读数据面例外。

### Fixed

- JS 渲染页面返回空字符串却 `exit 0`；现在渲染后仍无正文返回 `[FETCH_RENDER_FAIL]`。

## [0.3.4] - 2026-11-15

### Breaking

- **不再支持 Docker 部署**：删除 `docker/`、`Dockerfile`、`.dockerignore` 与 docker 镜像 workflow；安装器只接受 `--searxng-mode auto | native | external`。
- `bilibili` / `weibo` / `cnki` 三个内置抓取插件迁出核心，改由官方插件仓库安装；核心不再内置对应实现。

### Added

- 第三方扩展运行时加载：扫描 `data/extensions/<id>/`，按 `asg-plugin.json` 的 `provides` 读取命名导出 `fetch` / `engine`。
- fetch 注册表与 gateway engine 注册表支持外部插件注入；同 id 外部实现优先。
- 新增官方插件仓库与 `asg extensions install` 安装流程（单文件 ESM + SHA256SUMS）。
- 新增插件编写 skill，方便把插件开发交给 AI。

### Changed

- `asg engines list/enable/disable` 会先加载已安装的 search 插件。
- 原生 searxng 的 settings 模板与 quota 种子迁移到 `searxng-ext/`。

### Fixed

- 移除 `bilibili` / `weibo` / `cnki` 作为扩展 id 的安装拦截，官方插件可正常安装与卸载。

## [0.3.3] - 2026-11-15

### Added

- 第三方插件声明与安装薄层：`asg-plugin.json` 约定 `provides`（`search` / `fetch` / 两者），新增 `asg extensions search|install|list|remove`。
- 安装器从 GitHub Release 下载 `asg-plugin.json`、单文件 ESM `entry` 与 `SHA256SUMS`，校验后原子写入 `data/extensions/<id>/`；内置 id（`bilibili` / `weibo` / `cnki`）拒绝覆盖。
- 新增 `docs/extensions.md` 与 `examples/asg-plugin/` 模板（单文件 esbuild + `v*` tag 发布 workflow）。
- 当前只完成安装，网关不 import 插件、不重启整栈；运行时加载留到后续版本。

### Fixed

- 修复 Arch 下 FlareSolverr 自带 `libreadline` 与系统 `/bin/sh` 冲突：自检命中后禁用内置 readline 并重试。
- 服务管理器按安装根匹配：同名 systemd / launchd / schtasks 项属于其他安装根时回退 pid，安装器也不再覆盖其他 root 的自启项。
- 服务端测试固定 searxng 不可达端口，避免本机已有 searxng 时误判。

## [0.3.2] - 2026-11-14

### Added

- 抓取插件统一契约：`bilibili` / `weibo` / `cnki` 规范平台 ID 与别名归一化。
- 新增 `FetchPluginRegistry`，重复 ID fail-fast，统一 `enabled` 过滤；禁用后回退通用抓取。
- 新增 `env:NAME` 密钥引用与 `getSecretAtPath`，`secrets.yaml` 可引用环境变量。
- 新增 `FetchChannel` / `CliChannel` / `HttpChannel` 通道契约。
- 新增 `runCliProcess`，Bilibili / Weibo CLI 统一进程执行，永不 `shell:true`。
- 新增通道注册表：`bilibili:kukemc` / `bilibili:ytdlp` / `bilibili:article` / `weibo:opencli` / `cnki:http`。
- `asg plugins` 输出 `platform` / `channel` / `channel_id`，输入接受规范通道 ID 与旧别名。
- 新增 `docs/fetch-plugin-contract.md`。

### Changed

- 抓取插件 `match(url)` 改为纯 URL；`enabled(ctx)` 统一过滤；`available(ctx)` 仅用于维护面。
- 插件增加 `platform` / `aliases` / `displayName` / `settingsKey` / `capabilities` / `requires` / `channels`。
- Bilibili / Weibo CLI 执行统一走 `runCliProcess`。
- `fetch` 工具描述补充平台与通道列表；`fetch` 输出统一使用规范平台 ID。

## [0.3.1] - 2026-11-14

### Added

- 网关原生引擎 provider 注册层：新增以图搜图源或文本源只需 provider 文件 + 注册表一行，CLI 与运行期共用同一份定义。
- `asg engines` 纳入 `gateway.search:weibo`，支持 `group:name` 限定名；同名引擎用限定名区分。
- 新增 `docs/engine-provider.md`，说明引擎 provider 协议与新增源的步骤。

### Changed

- `asg engines` 的表格改用 `ID`；JSON 新增 `id` / `group`，旧字段保持不变。
- 引擎写入改为多存储适配器先 plan、再统一校验和提交；写失败会回滚已写文件。
- 微博搜索启用依赖顶层 `weibo.enabled`，缺失时返回 `MISSING_DEPENDENCY`。
- 反向图搜与微博搜索改由 provider 注册表分发，不再在 `search/service.ts` 里按源名分支。

### Fixed

- 修复 searxng 的 `baidu` 引擎被误当成网关以图搜图源 `gateway.reverse_image:baidu` 的问题。

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
