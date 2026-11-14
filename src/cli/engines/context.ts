/**
 * 引擎命令的只读加载上下文：gateway.yaml / secrets.yaml / searxng settings.yml。
 *
 * 只加载一次，供所有 EngineStore 共用；store 自身不再碰磁盘读取（写入仍由 catalog 落盘）。
 */

import { existsSync } from "node:fs";
import { CliError, EXIT } from "../errors.js";
import { readEndpoints } from "../ports.js";
import { rootPaths as resolveRootPaths } from "../root.js";
import { documentToPlain, readYamlDocument } from "../config/gateway.js";
import { readSearxngEngines } from "../config/searxng.js";
import type { EngineContext } from "./types.js";

export { rootPaths } from "../root.js";

const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";

/** 加载引擎读写所需的全部源数据；gateway.yaml 缺失视为未安装。 */
export function loadEngineContext(root: string): EngineContext {
  const paths = resolveRootPaths(root);
  if (!existsSync(paths.config)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到 gateway.yaml：${paths.config}`);
  }

  const config = readYamlDocument(paths.config);
  const configPlain = documentToPlain(config.doc);
  const secretsDoc = readYamlDocument(paths.secrets);

  let searxngUrl = DEFAULT_SEARXNG_URL;
  try {
    searxngUrl = readEndpoints(root).searxngUrl;
  } catch {
    // gateway.yaml 已成功解析；端口读取失败时保持默认值
  }

  return {
    paths,
    config,
    configPlain,
    secrets: documentToPlain(secretsDoc.doc),
    searxng: readSearxngEngines(paths.searxngSettings),
    searxngUrl,
  };
}
