# 一键安装器与跨平台依赖安装

## 背景

此前网关只有源码安装（`git clone` + `npm ci` + `npx playwright install`）和 Docker 两种方式；外部依赖 searxng / FlareSolverr 需要用户自行准备。目标机器没有开发工具链时无法安装，Windows 上尤其明显。

searxng 是搜索的强依赖。官方支持矩阵：Linux 源码/发行版包/Docker，没有 Windows 原生支持；`searx/valkeydb.py` 顶层 `import pwd` 且被 `searx/webapp.py` 无条件导入，导致 Windows 直接 `ModuleNotFoundError`。官方 issue #5411 标记 NOT_PLANNED，PR #5412 未合并。

FlareSolverr 是弱依赖，官方 Release 提供 `linux-x64` / `win32-x64` 二进制（v3.5.2），arm64 和 macOS 没有二进制。

## 决策

1. **两个引导脚本**：`scripts/install.sh`（Linux/macOS）与 `scripts/install.ps1`（Windows），支持 `curl | bash` / `irm | iex`。引导脚本只负责准备 Node、下载 Release 完整包、SHA256 校验、解压、切换 `data/current`；其余交给包内 `scripts/install/cli.mjs`。
2. **完整包安装**：安装器同样使用 CI 预构建包（含生产 `node_modules`），目标机器不需要 npm/tsc。
3. **searxng 平台策略**：
   - Linux/macOS：默认 Docker 起官方镜像；没有 Docker 时回退原生源码 + venv。
   - Windows x64：原生源码 + venv，自动打 `pwd` 补丁：
     ```python
     try:
         import pwd
     except ImportError:
         pwd = None
     ...
     if pwd:
         _pw = pwd.getpwuid(os.getuid())
     else:
         user_name, user_id = os.environ.get('USERNAME', 'unknown'), os.getpid()
     ```
   - 原生模式复制 `searxng-ext/` 自定义引擎与 quota 插件，生成项目 `settings.yml`。
4. **FlareSolverr**：x64 直接下载官方二进制；arm64 / macOS 无官方二进制时关闭该能力并提示（网关可用 Playwright 兜底部分场景）。
5. **版本随网关**：仓库维护 `runtime/pins.json`（searxng commit、FlareSolverr 版本、Playwright 版本）；CI 生成 `runtime.json` 随 Release 发布。安装器与自更新都读取它。
6. **自更新联动**：自更新切换版本后比较新包 `runtime/pins.json` 与 `data/runtime/deps.json`；依赖变化时调用新包 `cli.mjs --deps-only`，再重启与健康检查。
7. **统一自启**：`scripts/start-all.mjs` 读取 `data/runtime/launch.json`，按序启动 searxng → FlareSolverr → gateway；Linux systemd --user、macOS LaunchAgent、Windows 登录计划任务都指向同一入口。
8. **配置与密钥**：从示例生成 `gateway.yaml` / `secrets.yaml`；随机生成 `gateway.token`；`secrets.yaml` 权限 600。

## Consequences

- Windows 原生 searxng 属于非官方支持路径；上游改动 `valkeydb.py` 时补丁需要同步适配，`runtime/pins.json` 的 commit pin 保证可复现。
- searxng 是 AGPL-3.0，`searxng-ext` 也是 AGPL-3.0；安装器只在本地安装/修改，不把修改后的 searxng 打进发布包。
- Linux/macOS 无 Docker 时原生安装依赖 Python 3.11+ 与系统库；失败时安装器会明确报错并保留已安装的网关。
- arm64 的 FlareSolverr 能力默认关闭；需要时用 Docker。
- 安装器只管理用户级自启，不修改系统级服务；Windows 计划任务在登录后启动。
- `runtime/pins.json` 升级需要人工确认并重新发版，避免每次构建自动追最新导致不可复现。
