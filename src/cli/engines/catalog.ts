/**
 * 引擎目录：把多个 EngineStore 聚合成统一的 list / set 语义。
 *
 * - 名字解析支持 `group:name` 限定名；裸名命中多个 group 时报 ENGINE_AMBIGUOUS；
 * - 启用前检查 `requires`（secrets / config），批量全有或全无；
 * - 所有 store 先算写入计划，再统一校验、按顺序落盘，任一步失败恢复已写文件。
 */

import fs from "node:fs";
import { CliError, EXIT } from "../errors.js";
import { readTextIfExists, writeConfigFile, writeFileAtomic } from "../config/gateway.js";
import { validateConfigTexts } from "../config/validate.js";
import { loadEngineContext } from "./context.js";
import { dig } from "./shared.js";
import { GatewayStore } from "./stores/gateway.js";
import { SearxngStore } from "./stores/searxng.js";
import type {
  EngineChange,
  EngineContext,
  EngineGroup,
  EngineRecord,
  EngineStore,
  EngineWrite,
} from "./types.js";

/** 前缀按最长优先匹配。 */
const GROUP_PREFIXES: readonly EngineGroup[] = ["gateway.reverse_image", "gateway.search", "searxng"];

const STORES: readonly EngineStore[] = [new SearxngStore(), new GatewayStore()];

function localRecords(ctx: EngineContext): EngineRecord[] {
  return STORES.flatMap((store) => store.list(ctx));
}

/** 本地视图：只读 gateway.yaml / secrets.yaml / settings.yml，离线可用。 */
export function readLocalEngines(root: string): EngineRecord[] {
  return localRecords(loadEngineContext(root));
}

/** 本地列表；`all=true` 时叠加 searxng `/config` 的全量引擎。 */
export async function listEngines(
  root: string,
  options: { all?: boolean } = {},
): Promise<EngineRecord[]> {
  const ctx = loadEngineContext(root);
  const lists = await Promise.all(
    STORES.map((store) =>
      options.all && store.listAll ? store.listAll(ctx) : Promise.resolve(store.list(ctx)),
    ),
  );
  return lists.flat();
}

export function parseEngineRef(raw: string): { group?: EngineGroup; name: string } {
  const trimmed = raw.trim();
  for (const group of GROUP_PREFIXES) {
    const prefix = `${group}:`;
    if (trimmed.startsWith(prefix)) {
      return { group, name: trimmed.slice(prefix.length).trim() };
    }
  }
  return { name: trimmed };
}

function syntheticSearxng(name: string): EngineRecord {
  return {
    id: `searxng:${name}`,
    group: "searxng",
    name,
    kind: "searxng",
    enabled: true,
    available: true,
    routing: [],
  };
}

function notFound(names: readonly string[]): CliError {
  return new CliError("ENGINE_NOT_FOUND", EXIT.INVALID, `未知引擎：${names.join(", ")}`, {
    engines: [...names],
  });
}

function resolveRecords(
  requested: readonly string[],
  local: readonly EngineRecord[],
  knownSearxng: ReadonlySet<string>,
): EngineRecord[] {
  const resolved: EngineRecord[] = [];
  const unknown: string[] = [];

  for (const raw of requested) {
    const ref = parseEngineRef(raw);
    if (!ref.name) {
      unknown.push(raw);
      continue;
    }

    const matches = ref.group
      ? local.filter((record) => record.id === `${ref.group}:${ref.name}`)
      : local.filter((record) => record.name === ref.name);

    if (matches.length === 0) {
      if ((!ref.group || ref.group === "searxng") && knownSearxng.has(ref.name)) {
        resolved.push(syntheticSearxng(ref.name));
      } else {
        unknown.push(raw);
      }
      continue;
    }

    if (matches.length > 1) {
      const ids = matches.map((record) => record.id);
      throw new CliError(
        "ENGINE_AMBIGUOUS",
        EXIT.INVALID,
        `引擎名冲突：${raw}（${ids.join(", ")}），请使用 group:name 限定`,
        { engines: ids },
      );
    }

    resolved.push(matches[0]!);
  }

  if (unknown.length > 0) throw notFound(unknown);

  const seen = new Set<string>();
  return resolved.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

function requirementSatisfied(requirement: string, ctx: EngineContext): boolean {
  if (requirement.startsWith("secrets.")) {
    const value = dig(ctx.secrets, requirement.split(".").slice(1));
    return typeof value === "string" && value.trim().length > 0;
  }
  if (requirement.startsWith("config:")) {
    const value = dig(ctx.configPlain, requirement.slice("config:".length).split("."));
    return (
      value === true ||
      (typeof value === "string" && value.trim().length > 0) ||
      (Array.isArray(value) && value.length > 0)
    );
  }
  return false;
}

function checkRequirements(records: readonly EngineRecord[], ctx: EngineContext): void {
  const missing: Array<{ engine: string; requires: string[] }> = [];
  for (const record of records) {
    const lacks = (record.requires ?? []).filter((requirement) => !requirementSatisfied(requirement, ctx));
    if (lacks.length > 0) missing.push({ engine: record.id, requires: lacks });
  }
  if (missing.length === 0) return;

  const summary = missing.map((item) => `${item.engine} 需要 ${item.requires.join(", ")}`).join("；");
  const lacksSecret = missing.some((item) =>
    item.requires.some((requirement) => requirement.startsWith("secrets.")),
  );
  if (lacksSecret) {
    throw new CliError("MISSING_SECRET", EXIT.INVALID, `缺少密钥，拒绝启用：${summary}`, { missing });
  }
  throw new CliError("MISSING_DEPENDENCY", EXIT.INVALID, `缺少依赖，拒绝启用：${summary}`, { missing });
}

function pathRank(file: string, ctx: EngineContext): number {
  if (file === ctx.paths.searxngSettings) return 0;
  if (file === ctx.paths.config) return 1;
  return 2;
}

/**
 * 批量启用/禁用：先解析、校验依赖并生成全部写入计划，任一步失败不写任何文件；
 * 通过后按 searxng settings.yml → gateway.yaml 顺序落盘，任一步写失败恢复已写文件。
 * 调用方负责整栈重启一次。
 */
export function setEngines(
  root: string,
  names: readonly string[],
  enabled: boolean,
  options: { knownSearxng?: Iterable<string> } = {},
): { changed: string[] } {
  const requested = [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
  if (requested.length === 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "engines enable/disable 至少需要一个引擎名");
  }

  const ctx = loadEngineContext(root);
  const local = localRecords(ctx);
  const knownSearxng = new Set(options.knownSearxng ?? []);
  const records = resolveRecords(requested, local, knownSearxng);

  if (enabled) checkRequirements(records, ctx);

  const changes: EngineChange[] = records.map((record) => ({
    group: record.group,
    name: record.name,
    enabled,
  }));

  const writes: EngineWrite[] = [];
  const seenPaths = new Set<string>();
  for (const store of STORES) {
    const own = changes.filter((change) => store.groups.includes(change.group));
    if (own.length === 0) continue;
    for (const write of store.plan(own, ctx).writes) {
      if (seenPaths.has(write.path)) {
        throw new CliError("CONFIG_INVALID", EXIT.INVALID, `多个引擎写入同一文件：${write.path}`);
      }
      seenPaths.add(write.path);
      writes.push(write);
    }
  }

  const configWrite = writes.find((write) => write.path === ctx.paths.config);
  if (configWrite) {
    validateConfigTexts({ configText: configWrite.text, secretsText: readTextIfExists(ctx.paths.secrets) });
  }

  const ordered = [...writes].sort((a, b) => pathRank(a.path, ctx) - pathRank(b.path, ctx));
  const originals = new Map<string, string | undefined>();
  for (const write of ordered) originals.set(write.path, readTextIfExists(write.path));

  const written: string[] = [];
  try {
    for (const write of ordered) {
      if (write.path === ctx.paths.config) {
        writeConfigFile(write.path, write.text);
      } else {
        writeFileAtomic(write.path, write.text);
      }
      written.push(write.path);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      try {
        const original = originals.get(file);
        if (original === undefined) fs.unlinkSync(file);
        else writeFileAtomic(file, original);
      } catch {
        // 恢复失败不覆盖原始写入错误
      }
    }
    throw error;
  }

  return { changed: requested };
}
