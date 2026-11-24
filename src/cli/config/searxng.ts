/**
 * searxng settings.yml 的引擎读写。
 *
 * 真值就是文件：`engines[].disabled` 是唯一启用状态。列表顺序、其它字段与
 * 注释均保持不变；本地不存在该引擎时只追加最小条目 `{ name, disabled }`。
 */

import { isMap, isSeq, type YAMLMap, type YAMLSeq } from "yaml";
import { documentToText, readYamlDocument, writeFileAtomic } from "./gateway.js";
import { searxngSecretRequirement } from "../engines/requirements.js";
import { resolveSecretValue } from "../../settings/secret-ref.js";

export interface SearxngEngineState {
  name: string;
  enabled: boolean;
  /** settings.yml 里的原始 api_key；字段不存在时为 undefined。 */
  apiKey?: string;
  /** settings.yml 里 `about.require_api_key` 的显式覆盖；缺省表示未显式声明 keyless。 */
  requireApiKey?: boolean;
}

export interface SearxngWriteResult {
  changed: string[];
  appended: string[];
}

export interface SearxngRenderResult extends SearxngWriteResult {
  /** 无实际变化时为 undefined。 */
  text?: string;
}

function enginesSeq(doc: ReturnType<typeof readYamlDocument>["doc"], create: boolean): YAMLSeq | undefined {
  const node = doc.get("engines", true) as unknown;
  if (isSeq(node)) return node;
  if (!create) return undefined;
  const seq = doc.createNode([]) as YAMLSeq;
  doc.set("engines", seq);
  return seq;
}

function findEngine(seq: YAMLSeq, name: string): YAMLMap | undefined {
  for (const item of seq.items) {
    if (isMap(item) && item.get("name") === name) return item;
  }
  return undefined;
}

const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 解析 searxng 引擎的 api_key 值。
 *
 * settings.yml 由安装器写成明文，但用户也可能保留 `env:NAME` 或 `${NAME}`
 * 占位符；判断“是否配置”必须看解析后的值。
 */
export function resolveSearxngApiKey(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveSecretValue(raw, env).replace(ENV_PLACEHOLDER, (_match, name: string) =>
    env[name] ?? "",
  );
}

/**
 * 该 searxng 引擎声明的 api_key 依赖；不需要密钥时返回 undefined。
 *
 * 声明规则：settings.yml 条目里有 `api_key` 字段即视为需要密钥；
 * `about.require_api_key: false` 可显式覆盖（keyless 引擎）。
 */
export function searxngApiKeyRequirement(engine: SearxngEngineState): string | undefined {
  if (engine.apiKey === undefined || engine.requireApiKey === false) return undefined;
  return searxngSecretRequirement(engine.name);
}

/** api_key 是否已配置（解析后的值非空）。 */
export function hasSearxngApiKey(
  engine: SearxngEngineState,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return engine.apiKey !== undefined && resolveSearxngApiKey(engine.apiKey, env).trim().length > 0;
}

/** 读取本地 settings.yml 中的引擎（文件缺失 → 空数组）。 */
export function readSearxngEngines(file: string): SearxngEngineState[] {
  const { doc } = readYamlDocument(file);
  const seq = enginesSeq(doc, false);
  if (!seq) return [];

  const engines: SearxngEngineState[] = [];
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const name = item.get("name");
    if (typeof name !== "string" || !name) continue;

    let apiKey: string | undefined;
    if (item.has("api_key")) {
      const raw = item.get("api_key");
      apiKey =
        typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
    }

    let requireApiKey: boolean | undefined;
    const about = item.get("about", true);
    if (isMap(about)) {
      const flag = about.get("require_api_key");
      if (typeof flag === "boolean") requireApiKey = flag;
    }

    engines.push({
      name,
      enabled: item.get("disabled") !== true,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(requireApiKey === undefined ? {} : { requireApiKey }),
    });
  }
  return engines;
}

/**
 * 计算批量启用状态后的 settings.yml 文本，不落盘。
 * 本地不存在则追加 `{ name, disabled }`；存在则只改 disabled。
 */
export function renderSearxngEngineStates(
  file: string,
  changes: ReadonlyArray<{ name: string; enabled: boolean }>,
): SearxngRenderResult {
  const { doc } = readYamlDocument(file);
  const seq = enginesSeq(doc, true)!;
  const changed: string[] = [];
  const appended: string[] = [];

  for (const change of changes) {
    const entry = findEngine(seq, change.name);
    const nextDisabled = !change.enabled;

    if (!entry) {
      seq.add(doc.createNode({ name: change.name, disabled: nextDisabled }));
      appended.push(change.name);
      changed.push(change.name);
      continue;
    }

    if (entry.get("disabled") !== nextDisabled) {
      entry.set("disabled", nextDisabled);
      changed.push(change.name);
    }
  }

  return {
    text: changed.length > 0 ? documentToText(doc) : undefined,
    changed,
    appended,
  };
}

/**
 * 批量写入启用状态。本地不存在则追加 `{ name, disabled }`；存在则只改 disabled。
 * 返回实际变化的引擎名与本轮新增的引擎名。
 */
export function writeSearxngEngineStates(
  file: string,
  changes: ReadonlyArray<{ name: string; enabled: boolean }>,
): SearxngWriteResult {
  const { text, changed, appended } = renderSearxngEngineStates(file, changes);
  if (text !== undefined) writeFileAtomic(file, text);
  return { changed, appended };
}

export interface SearxngApiKeyRenderResult {
  /** 值是否有变化。 */
  changed: boolean;
  /** 无实际变化时为 undefined。 */
  text?: string;
}

/**
 * 计算写入某个 searxng 引擎 api_key 后的 settings.yml 文本，不落盘。
 * 只改 `engines[].api_key`，保留条目顺序、其它字段与注释。
 */
export function renderSearxngEngineApiKey(
  file: string,
  name: string,
  value: string,
): SearxngApiKeyRenderResult {
  const { doc } = readYamlDocument(file);
  const seq = enginesSeq(doc, false);
  if (!seq) return { changed: false };

  const entry = findEngine(seq, name);
  if (!entry) return { changed: false };
  if (entry.get("api_key") === value) return { changed: false };

  entry.set("api_key", value);
  return { changed: true, text: documentToText(doc) };
}

/** 写入（或清空）某个 searxng 引擎的 api_key；返回是否有变化。 */
export function writeSearxngEngineApiKey(file: string, name: string, value: string): boolean {
  const result = renderSearxngEngineApiKey(file, name, value);
  if (result.text !== undefined) writeFileAtomic(file, result.text);
  return result.changed;
}
