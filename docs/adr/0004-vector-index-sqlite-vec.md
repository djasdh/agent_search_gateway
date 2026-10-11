# 用 sqlite-vec 原生扩展做向量检索

向量存储走磁盘 SQLite（`node:sqlite`），检索用 `sqlite-vec` 原生扩展（通过 `loadExtension` 加载）做 KNN。目标是内存不常驻、检索不靠 JS 暴力重算。

## Considered Options

- **纯 JS 暴力扫**：无原生依赖，但语料增大后台式阻塞 MCP 事件循环；被否。
- **全量载入内存 ANN**：检索最快，但违背「内存不要动」；被否。

## Consequences

- 需要按平台分发/加载原生扩展（类似 playwright），部署复杂度上升。
- `node:sqlite` 为同步 API，请求路径上应避免全表扫描。
