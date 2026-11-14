# CLI 作为统一控制面

- 状态：已接受
- 日期：2026-11-13
- 细化契约：`docs/cli-contract.md`

## 背景

网关的数据面是 MCP server：`/mcp` 提供 search、fetch、browser_*、health 等工具。网关本身只把 searxng 和 FlareSolverr 当作 HTTP 后端，只在 BrowserPool 内懒加载并回收 Playwright Chromium；它**不负责**安装、启动、停止或重启 searxng / FlareSolverr，也不管理 Chromium 二进制。

当前管理逻辑分散在多个脚本里：

- `scripts/install/cli.mjs`：安装 searxng、FlareSolverr、Playwright，生成配置与 `launch.json`
- `scripts/start-all.mjs`：读取 `launch.json`，启动并监督各服务
- `scripts/gateway.sh` / `gateway.ps1`：单机 start / stop / restart / status / logs
- `scripts/backends/cli.mjs`：外部后端插件安装、更新、卸载
- `scripts/self-update/`：core 自更新
- `gateway.yaml`、`secrets.yaml`、searxng `settings.yml`：三套配置

桌面应用如果直接读写这些文件、spawn 服务、kill PID，就会复制一套管理逻辑，并与 headless 行为漂移。ADR-0016 和 ADR-0017 已经把安装、自更新、跨平台自启固定下来；这些能力需要被统一暴露，而不是重写。

## 决策

1. **新增 `asg` CLI，作为唯一管理入口。**

   “控制面”包括：运行时启停、状态、日志、配置、搜索引擎、插件、浏览器组件、更新、诊断。MCP `/mcp` 仍是数据面，不承载管理操作。安装仍由 `install.sh` / `install.ps1` 负责，CLI 在安装完成后才存在。

2. **CLI 版本化在 `dist/cli/`，随 core 自更新。**

   源码放 `src/cli/`，编译到 `dist/cli/`；`package.json` 提供 `bin.asg`。

   安装根保留一个约 10 行的稳定入口 `bin/asg.mjs`：只解析 `data/current` 或 `data/current.json`、转发到 `dist/cli`、透传参数与退出码。systemd / launchd / 计划任务都指向它，因此 `asg update` 切换版本后不需要改写服务单元。

3. **CLI 不重新实现底层能力。**

   - 安装 → 仍由 `scripts/install.sh` / `install.ps1` 引导，安装库保留在 `scripts/install/`
   - 启停/监督 → 把 `start-all` 的逻辑收进 `asg serve`
   - 插件 → 包装 `scripts/backends/cli.mjs`，补 `--root` 与 `--json`
   - 浏览器 → 调用 Playwright CLI，默认 `--only-shell`
   - 更新 → 复用 self-update 引擎
   - 依赖版本 → 继续以 `runtime/pins.json` 为唯一来源

4. **命令面（草案）。**

   | 命令 | 作用 |
   |---|---|
   | `asg status [--json]` | 三个服务的现场探测 |
   | `asg start` | 启动整栈 |
   | `asg stop` | 停止整栈 |
   | `asg restart` | 重启整栈 |
   | `asg serve` | 前台 supervisor，供服务管理器调用 |
   | `asg logs [service] [-f]` | 日志 |
   | `asg config get/set/validate` | `gateway.yaml` / `secrets.yaml` |
   | `asg engines list/enable/disable` | searxng `settings.yml` |
   | `asg plugins list/install/remove` | 外部后端 |
   | `asg browser status/install [--full]` | Playwright 浏览器 |
   | `asg adlist update` | 广告过滤列表 |
   | `asg update check/apply` | core 自更新 |
   | `asg doctor` | 环境与配置检查 |

   命令命名可以再调；契约（文件、输出、退出码）以 `docs/cli-contract.md` 为准。

5. **输出契约。**

   人用默认文本；机器用 `--json`（恰好一个 result）；长任务用 `--jsonl`（NDJSON，最后一行为 result）。`--json` 时 stdout 只放 JSON，诊断走 stderr。退出码固定 `0/1/2/3/4`。

6. **进程模型。**

   - 生命周期单位是**整栈**：只提供 `start` / `stop` / `restart`，不提供单组件操作；
   - `asg serve` 就是 supervisor，保持现有 `start-all` 语义：按 `launch.json` 启动、健康轮询、任一子进程退出则整栈停止并以非 0 退出，交给服务管理器重启；
   - 已注册服务管理器时，CLI 只调用平台命令；未注册时，`asg start` 以 detached 方式启动 `asg serve`，pid 写入 `data/runtime/supervisor.pid`；
   - 不引入 `state.json`、`desired.json`、控制 socket 或 named pipe；
   - `asg status` 只做 HTTP 探测，不读写状态文件。

7. **配置与引擎语义。**

   - 配置真值就是文件：`gateway.yaml`、`secrets.yaml`、searxng `settings.yml`；
   - 写入流程：用临时文件跑 `loadSettings()` 校验 → 备份 `.bak` → 原子写 → **整栈重启** → 健康检查；
   - 校验失败不写文件；写入失败原文件不变；重启失败保留备份、不自动回滚；
   - 整栈重启会断开 MCP 连接，人类输出必须明确提示；
   - `engines` 在用户层统一：`kind=searxng` 写 `settings.yml`，`kind=gateway` 写 `gateway.yaml` 的 `search.reverse_image.sources`；缺 secret 的引擎直接拒绝启用；
   - `resident / rotating` 第一版只显示，不提供编辑；
   - `plugins` 只改 `gateway.yaml`；两者都通过整栈重启生效。

8. **兼容性。**

   - 0.3.0 起 `asg` 是唯一管理入口，**要求重装**；
   - 不保留 `gateway.sh` / `gateway.ps1` / 单组件重启等旧行为；
   - headless 与桌面共用同一 CLI，不出现两套行为；
   - 服务单元统一指向 `bin/asg.mjs`。

9. **非目标。**

   - 单组件启停 / 重启；
   - Docker 模式的进程管理（`--searxng-mode` 默认改为 native）；
   - 远程多用户管理、Web 管理台；
   - 首版打成单二进制（Node SEA 留待后续评估）。

## 考虑过的替代方案

- **GUI 直接操作文件/进程**：会复制 YAML、PID、日志、健康检查逻辑，headless 与 GUI 容易分叉。否决。
- **网关新增 HTTP 管理 API**：需要鉴权/CORS/端口，且网关并不拥有 searxng/FlareSolverr 的 PID；不符合“不要 Web 管理台”的方向。否决。
- **用 MCP 工具做管理**：MCP 是 agent 数据面，不是生命周期管理面。否决。
- **本地 socket / named pipe 做单组件控制**：跨平台两套实现、权限与残留问题，收益只有单组件重启；而整栈重启已经够用。否决。
- **`state.json` + desired/observed reconcile**：对一个只需要回答“三个服务活着没有”的 CLI 过重。否决。
- **继续维护多套脚本**：配置、日志、退出码、跨平台行为会持续漂移。否决。

## Consequences

- CLI 成为稳定公共契约，需要 JSON 输出与跨平台启停的回归测试。
- `start-all.mjs` 的 supervisor 逻辑移入 `asg serve`，语义不变；服务单元 ExecStart 改为 `bin/asg.mjs serve`。
- 单组件重启被移除：改搜索引擎或配置都会整栈重启，MCP 连接会断开。
- `scripts/` 下的旧入口删除，0.3.0 需要重装；不维护兼容层。
- `bin/asg.mjs` 必须保持极薄且稳定，不随版本变化。
- `runtime/pins.json` 仍是版本唯一来源；CLI 不自动追最新。
