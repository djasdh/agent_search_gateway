/**
 * gateway.yaml / secrets.yaml 的 YAML Document 读写基元。
 *
 * 设计要点：
 * - 用 `parseDocument` 而不是 `parse`，保留注释与键顺序；
 * - 写入一律「备份 .bak → 临时文件 → rename 原子替换」；
 * - 本模块只做文件与值操作，不做 schema 校验（见 validate.ts）。
 */

import fs from "node:fs";
import path from "node:path";
import { Document, isMap, parseDocument } from "yaml";
import { CliError, EXIT } from "../errors.js";
import { rootPaths } from "../root.js";

export type YamlPath = readonly string[];

export type ConfigTarget = "config" | "secrets";

export interface ConfigPaths {
  config: string;
  secrets: string;
}

export interface LoadedDocument {
  doc: Document.Parsed;
  /** 原始文本；文件不存在时为空串。 */
  text: string;
  exists: boolean;
}

export interface ResolvedConfigPath {
  target: ConfigTarget;
  path: string[];
  /** 规范化后的点号路径，用于返回值与提示。 */
  display: string;
}

export function configPaths(root: string): ConfigPaths {
  const paths = rootPaths(root);
  return { config: paths.config, secrets: paths.secrets };
}

export function configPathFor(root: string, target: ConfigTarget): string {
  return target === "secrets" ? configPaths(root).secrets : configPaths(root).config;
}

export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 读取 YAML Document；文件缺失时返回空对象文档（exists=false），
 * 便于 `config set` 在 secrets.yaml 不存在时新建。
 */
export function readYamlDocument(file: string): LoadedDocument {
  if (!fs.existsSync(file)) {
    return { doc: parseDocument("{}") as Document.Parsed, text: "", exists: false };
  }

  const text = fs.readFileSync(file, "utf8");
  let doc: Document.Parsed;
  try {
    doc = parseDocument(text) as Document.Parsed;
  } catch (error) {
    throw new CliError(
      "CONFIG_INVALID",
      EXIT.INVALID,
      `${file} 解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (doc.errors.length > 0) {
    throw new CliError(
      "CONFIG_INVALID",
      EXIT.INVALID,
      `${file} 解析失败：${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }

  if (doc.contents === null || doc.contents === undefined) {
    return { doc: parseDocument("{}") as Document.Parsed, text, exists: true };
  }
  if (!isMap(doc.contents)) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, `${file} 内容必须是 YAML 对象`);
  }

  return { doc, text, exists: true };
}

/** 序列化为可写回文件的文本（保持块状风格，不折行）。 */
export function documentToText(doc: Document.Parsed): string {
  const text = doc.toString({ lineWidth: 0 });
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Document → 普通 JS 对象（缺失时为空对象）。 */
export function documentToPlain(doc: Document.Parsed): Record<string, unknown> {
  const value = doc.toJS() as unknown;
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, "配置内容必须是 YAML 对象");
  }
  return value as Record<string, unknown>;
}

function dig(obj: unknown, path: YamlPath): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** 按点号路径取值；返回普通 JS 值。 */
export function getYamlPath(doc: Document.Parsed, path: YamlPath): unknown {
  return dig(documentToPlain(doc), path);
}

/** 按点号路径写值，中间对象不存在时自动创建。 */
export function setYamlPath(doc: Document.Parsed, path: YamlPath, value: unknown): void {
  if (path.length === 0) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, "配置路径不能为空");
  }

  let current: unknown = doc.getIn(path.slice(0, -1), true);
  if (path.length > 1 && (current === undefined || current === null)) {
    doc.setIn(path.slice(0, -1) as string[], doc.createNode({}));
    current = doc.getIn(path.slice(0, -1), true);
  }
  if (path.length > 1 && !isMap(current)) {
    throw new CliError(
      "CONFIG_INVALID",
      EXIT.INVALID,
      `${path.slice(0, -1).join(".")} 不是对象，无法写入 ${path.join(".")}`,
    );
  }

  doc.setIn(path as string[], value);
}

/** CLI 值语法：先 JSON.parse，失败按字符串；--string 强制字符串。 */
export function parseConfigValue(raw: string, forceString = false): unknown {
  if (forceString) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * 解析 `secrets.gateway.token` 这类路径。
 * 顶层 `secrets` 前缀选择 secrets.yaml，其余段原样作为 YAML 路径。
 */
export function resolveConfigPath(raw: string): ResolvedConfigPath {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "配置路径不能为空");
  }

  let target: ConfigTarget = "config";
  let rest = trimmed;
  if (trimmed === "secrets" || trimmed.startsWith("secrets.")) {
    target = "secrets";
    rest = trimmed.slice("secrets".length);
    if (rest.startsWith(".")) rest = rest.slice(1);
  }

  const segments = rest.length === 0 ? [] : rest.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `非法配置路径：${raw}`);
  }
  if (target === "config" && segments.length === 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "配置路径不能为空");
  }

  return {
    target,
    path: segments,
    display: target === "secrets" ? ["secrets", ...segments].join(".") : segments.join("."),
  };
}

/** 单个密钥的展示值：永不输出明文。 */
export function maskSecretValue(value: unknown): "set" | "unset" {
  if (typeof value === "string") return value.trim().length > 0 ? "set" : "unset";
  return value === undefined || value === null ? "unset" : "set";
}

/** 深拷贝并掩码整棵 secrets 树（所有字符串 → set/unset）。 */
export function maskSecretsTree(value: unknown): unknown {
  if (typeof value === "string") return maskSecretValue(value);
  if (Array.isArray(value)) return value.map((item) => maskSecretsTree(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskSecretsTree(item);
    }
    return out;
  }
  return value === undefined ? "unset" : value;
}

function fileMode(file: string, fallback: number): number {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}

/** 同目录临时文件 + rename，保证读者永远看到完整内容。 */
export function writeFileAtomic(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const resolvedMode = mode ?? fileMode(file, 0o644);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: resolvedMode });
    fs.chmodSync(tmp, resolvedMode);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能未创建/已改名；忽略清理失败
    }
    throw error;
  }
}

/**
 * 配置写入：先备份 `<file>.bak`，再原子替换。
 * 备份的是「写入前」的内容；重启失败时用户可据此手工回滚。
 */
export function writeConfigFile(file: string, text: string, mode?: number): void {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak`);
  }
  writeFileAtomic(file, text, mode);
}

export function backupPath(file: string): string {
  return `${file}.bak`;
}
