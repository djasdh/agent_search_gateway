/** data/runtime/launch.json 的读取与校验（语义对齐原 scripts/start-all.mjs）。 */

import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { rootPaths } from "../root.js";

export interface LaunchService {
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  health: string | null;
}

export interface LaunchConfig {
  services: LaunchService[];
  warnings: string[];
}

export function launchConfigPath(root: string): string {
  return rootPaths(root).launch;
}

function schemaError(message: string): CliError {
  return new CliError("SCHEMA_MISMATCH", EXIT.INVALID, message);
}

function validateService(item: unknown, index: number, root: string): LaunchService {
  const label = `services[${index}]`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw schemaError(`${label} 必须是对象`);
  }
  const record = item as Record<string, unknown>;

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    throw schemaError(`${label}.name 必须是非空字符串`);
  }

  if (!Array.isArray(record.command) || record.command.length === 0) {
    throw schemaError(`${name}.command 必须是非空字符串数组`);
  }
  const command = record.command.map((part, partIndex) => {
    if (typeof part !== "string" || part === "") {
      throw schemaError(`${name}.command[${partIndex}] 必须是非空字符串`);
    }
    return part;
  });

  let cwd = root;
  if (record.cwd !== undefined && record.cwd !== null) {
    if (typeof record.cwd !== "string" || record.cwd.trim() === "") {
      throw schemaError(`${name}.cwd 必须是非空字符串`);
    }
    cwd = path.resolve(root, record.cwd);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw schemaError(`${name}.cwd 不存在：${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw schemaError(`${name}.cwd 不是目录：${cwd}`);
  }

  const env: Record<string, string> = {};
  if (record.env !== undefined && record.env !== null) {
    if (typeof record.env !== "object" || Array.isArray(record.env)) {
      throw schemaError(`${name}.env 必须是对象`);
    }
    for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
      if (value === null || typeof value === "object") {
        throw schemaError(`${name}.env.${key} 必须是字符串、数字或布尔值`);
      }
      env[key] = String(value);
    }
  }

  let health: string | null = null;
  if (record.health !== undefined && record.health !== null && record.health !== "") {
    if (typeof record.health !== "string") {
      throw schemaError(`${name}.health 必须是 http(s) URL 字符串`);
    }
    let url: URL;
    try {
      url = new URL(record.health);
    } catch {
      throw schemaError(`${name}.health 不是合法 URL：${record.health}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw schemaError(`${name}.health 只支持 http/https：${record.health}`);
    }
    health = record.health;
  }

  return { name, command, cwd, env, health };
}

/** 解析 launch.json 文本；root 用于解析相对 cwd。 */
export function parseLaunchConfig(text: string, root: string): LaunchConfig {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let data: unknown;
  try {
    data = JSON.parse(normalized);
  } catch (error) {
    throw schemaError(
      `启动配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw schemaError("启动配置必须是 JSON 对象");
  }

  const record = data as Record<string, unknown>;
  if (record.services === undefined) {
    return { services: [], warnings: ["launch.json 未包含 services，按空列表处理"] };
  }
  if (!Array.isArray(record.services)) {
    throw schemaError("launch.json 的 services 必须是数组");
  }

  const names = new Set<string>();
  const services = record.services.map((item, index) => {
    const service = validateService(item, index, root);
    if (names.has(service.name)) {
      throw schemaError(`launch.json 中存在重复的服务名：${service.name}`);
    }
    names.add(service.name);
    return service;
  });

  return { services, warnings: [] };
}

export function loadLaunchConfig(root: string, file = launchConfigPath(root)): LaunchConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw schemaError(
      `无法读取启动配置 ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseLaunchConfig(text, root);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(error.code, error.exitCode, `${error.message}（${file}）`, error.details);
    }
    throw error;
  }
}
