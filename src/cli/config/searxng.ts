/**
 * searxng settings.yml 的引擎读写。
 *
 * 真值就是文件：`engines[].disabled` 是唯一启用状态。列表顺序、其它字段与
 * 注释均保持不变；本地不存在该引擎时只追加最小条目 `{ name, disabled }`。
 */

import { isMap, isSeq, type YAMLMap, type YAMLSeq } from "yaml";
import { documentToText, readYamlDocument, writeFileAtomic } from "./gateway.js";

export interface SearxngEngineState {
  name: string;
  enabled: boolean;
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
    engines.push({ name, enabled: item.get("disabled") !== true });
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
