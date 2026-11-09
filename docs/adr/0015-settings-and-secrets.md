# 设置与密钥分离，组件按切片接收配置

## 背景

原先 `src/config.ts` 用 zod 定义嵌套 schema，但 `loadConfig` 把它拍平成约 100 个前缀字段的 `GatewayConfig`（`searchXxx` / `fetchXxx` / `browserXxx`…）。该扁平对象被整体传给所有组件，每个组件只读其中一小片；密钥（`gateway.token`、`embedding.api_key`、`saucenao.api_key`、`bilibili.http.token`、`browser.proxy_password`）混在设置文件里，且部分用环境变量覆盖。

## 决策

1. **类型即 YAML**：内部类型与 YAML 文档同构（嵌套、`snake_case`），不再做「YAML → 扁平前缀字段」的映射。
2. **单一入口**：`src/settings/` 只暴露 `loadSettings()`，一次返回 `{ settings, secrets, warnings }`。
3. **密钥独立**：敏感值只存在 `secrets.yaml`（结构路径与设置对应），加载后是独立的 `Secrets` 对象，不合并进 `Settings`；`gateway.yaml` 出现旧密钥字段会直接报错（空值则忽略并 warning），避免静默变成未鉴权。
4. **按需透传**：根节点（`server.ts`）负责装配；组件只接收自己那段设置子树与需要的密钥切片（如 `SearchSettingsDeps`、`FetchServiceDeps`、`BrowserPoolSettings`）。
5. **启动时加载一次**：不支持热更新；进程级单例的初始化参数在启动时确定。
6. **严格校验**：所有配置对象 `strict`，未知字段直接报错；`search.engines` 只接受 `{ resident, rotating }`，不再兼容旧平铺数组。

## Consequences

- `gateway.yaml` 与 `secrets.yaml` 默认同目录；可用 `GATEWAY_CONFIG_FILE` / `GATEWAY_SECRETS_FILE` 覆盖路径。
- 环境变量 `GATEWAY_TOKEN` / `EMBEDDING_API_KEY` / `SAUCENAO_API_KEY` / `BILIBILI_HTTP_TOKEN` / `BROWSER_PROXY_PASSWORD` 优先级最高。
- 旧配置需要迁移：密钥移到 `secrets.yaml`，`search.engines` 改为分档对象；启动时会给出明确错误。
- 测试与运行时共用 `defaultSettings()`，避免默认值两份漂移。
- 组件边界成为显式依赖声明；新增组件时应定义自己的 settings 切片，不再把全量配置传下去。
