# GUI 以 CLI 为唯一后端

- 状态：已接受
- 日期：2026-11-13
- 细化契约：`docs/cli-contract.md`

## 背景

桌面应用是 Win/macOS 的主发布物，但管理界面本身只承担状态展示、开关、滑块、日志、插件安装等交互。真正的业务逻辑已经在 ADR-0018 中收敛到 `asg` CLI。

如果 GUI 直接读写 `gateway.yaml` / `secrets.yaml` / searxng `settings.yml`，直接 spawn/kill 服务，或者自己解析 `launch.json`，它就会和 CLI/headless 形成第二套管理逻辑。换 GUI 壳时还要重写这些逻辑。

本 ADR 只约束 GUI 与 CLI 的边界，不选择 GUI 框架。Tauri、Slint 或其他原生壳都可以，选型另议。

## 决策

1. **GUI 不直接管理运行时。**

   不读写 `gateway.yaml` / `secrets.yaml` / searxng `settings.yml`，不直接 spawn/kill searxng、FlareSolverr、gateway，不解析 `launch.json`，不直接操作 PID，也不直接启动 Playwright Chromium。

2. **GUI 只调用 `asg` CLI。**

   统一执行 `$ROOT/bin/asg.mjs`，使用参数数组 spawn，不经过 shell；设置 `cwd`，必要时传 `--root`。读取 stdout 的 `--json` / `--jsonl` 输出，GUI 不解析人类可读文本。不使用环境变量传递安装根。

3. **GUI 只负责展示与交互。**

   状态、日志、进度、确认、文件选择、托盘、更新提示由 GUI 承担；业务规则、校验、回滚、进程顺序全部在 CLI。

4. **长任务与取消。**

   GUI 订阅 CLI 的 NDJSON 事件；取消时向 CLI 发 SIGTERM，由 CLI 负责杀子进程树。GUI 不自行 kill 服务。

5. **GUI 不接触密钥明文。**

   `asg status --json` 只返回“已配置/未配置”；设置密钥通过 CLI stdin 或一次性输入，不进 argv、不进 GUI 日志。

6. **路径约定。**

   CLI 稳定入口为 `$ROOT/bin/asg.mjs`，Node 使用 core 的 `data/toolchain/node`（或桌面安装包内置的 Node）。GUI 只解析这一个路径，不内嵌 Node 业务逻辑。

7. **不做 Web 管理台。**

   GUI 不需要 HTTP API；CLI 不监听任何端口，也没有本地 socket。supervisor 只通过子进程和 `data/runtime/supervisor.pid` 工作。

8. **GUI 壳选型与 ADR 解耦。**

   GUI 可以更换框架，只要遵守“只调 CLI”的契约。壳的内存、体积、开发成本单独评估，不在本 ADR 中定案。

9. **首次安装。**

   安装器负责把 core 放到 `data/current` 并准备 Node；core 就绪后，GUI 的启停、状态、配置、插件全部走 `asg`。GUI 不复制安装器逻辑，也不调用 `asg` 做首次安装。

10. **生命周期是整栈。**

    GUI 只暴露“启动 / 停止 / 重启”，不出现单组件启停。任何配置或引擎改动都会触发整栈重启，UI 必须提示 MCP 连接会断开。

## 考虑过的替代方案

- **GUI 直接读写 YAML/进程**：实现快，但会与 CLI/headless 分叉。否决。
- **GUI 直接 import Node 控制库**：对 Node 系壳可行，但会把 GUI 绑死在 Node 运行时，其他壳无法复用。否决。
- **GUI 内嵌 HTTP 管理 API**：需要鉴权/CORS/端口，且又变成 Web 管理台。否决。
- **GUI 通过 MCP 工具管理**：MCP 是 agent 数据面，不是生命周期管理面。否决。

## Consequences

- GUI 很薄，换壳成本低；headless 与桌面共用同一套行为。
- CLI 的 JSON 输出成为 GUI 的 API，必须保持稳定并做契约测试。
- GUI 不能做 CLI 没暴露的操作；新功能先加到 CLI，再加 UI。
- CLI 必须处理好进度、取消、退出码；整栈重启会断开 MCP 连接，UI 需要明确提示。
- CLI 必须在 core 就绪后可用；首次 bootstrap 仍由安装器负责，不把安装逻辑塞进 GUI。
- 桌面端的内存/体积主要由 core 和 Playwright 决定，GUI 壳不再是主要成本。
