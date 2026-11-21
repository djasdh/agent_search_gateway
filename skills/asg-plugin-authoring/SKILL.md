---
name: asg-plugin-authoring
description: 为 agent-search-gateway（asg）0.4.0+ 编写、迁移或发布 V2 插件时使用。适用于：从零生成 V2 插件仓库、编写 asg-extension.json（api_version 2）、迁移旧 V1 插件、打包单文件 ESM（index.mjs），以及配置 v* Release 与 asg-plugin topic。
---

# 编写 asg 第三方插件（V2）

本 skill 面向 **0.4.0 及以后**的插件开发。

> **0.4.0 起只接受 V2 manifest（`asg-extension.json`，`api_version: 2`）。**
> 运行期不再加载 `asg-plugin.json`；旧 V1 插件必须先按
> [`v2skills.md`](v2skills.md) 第 9 节迁移。

## 怎么用

- **新插件 / 迁移 / 发布**：直接读 [`v2skills.md`](v2skills.md)，那里有完整步骤、
  manifest 模板、`FetchProvider` / `EngineProvider`、`setup(ctx)`、配置与密钥、CI 发布。
- **Q&A 与示例**：V2 的 fetch 示例见 [`examples/fetch-plugin.ts`](examples/fetch-plugin.ts)，
  搜索源示例见 [`examples/search-engine.ts`](examples/search-engine.ts)。
- **旧 V1 文档**：[`legacy/`](legacy/) 只适用于 0.3.x，0.4.0 起不要再按它新建或发布插件。
  - [`legacy/v1skills.md`](legacy/v1skills.md)：V1 完整指南；
  - [`legacy/references/`](legacy/references/)：V1 manifest / setup / release 等细节。

## 0.4.0 的关键边界

1. 安装单元是 **extension**，manifest 固定为 `asg-extension.json`，`api_version` 必须为 `2`。
2. 运行期类型统一叫 `FetchProvider`（旧文档里的 `FetchPlugin` 是 0.3.x 名称）。
3. 插件只读 `ctx.pluginConfig` / `ctx.pluginSecrets` / `ctx.pluginBackends`；
   不要再读 `ctx.settings` / `ctx.config`。
4. 平台配置只写 `gateway.yaml → extensions.<id>.config`；密钥只写
   `secrets.yaml → extensions.<id>.<name>`。
5. 官方插件版本：bilibili / cnki `0.2.0`，weibo `0.2.2`。
6. `scripts/migrations/` 与 `asg plugins` 只存在于 0.3.11–0.4.0；**0.4.1 已删除**。
   从 0.3.x 升级要在安装 0.4.0 之前跑完迁移脚本。

## 交付前

按 [`v2skills.md`](v2skills.md) 第 10 节的检查清单逐项确认；旧项目先看第 9 节迁移步骤。
