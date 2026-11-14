/**
 * 统一引擎目录：把 searxng 引擎与网关原生源收敛到同一套 list/enable/disable 语义。
 *
 * - kind=searxng：`data/deps/searxng/settings.yml` 的 `engines[].disabled`；
 * - kind=gateway：`gateway.yaml` 的 `search.reverse_image.sources`。
 *
 * list 不联网；list --all 才请求 searxng `/config`，不可达报 BACKEND_DOWN。
 */

import { existsSync } from "node:fs";
import { CliError, EXIT } from "../errors.js";
import { readEndpoints } from "../ports.js";
import { rootPaths } from "../root.js";
import {
  documentToPlain,
  documentToText,
  readTextIfExists,
  readYamlDocument,
  setYamlPath,
  writeConfigFile,
  type LoadedDocument,
} from "./gateway.js";
import { readSearxngEngines, writeSearxngEngineStates } from "./searxng.js";
import { validateConfigTexts } from "./validate.js";
import {
  GATEWAY_SOURCE_SPECS,
  gatewaySourceSpec,
  isGatewaySource,
  type GatewaySource,
} from "../../settings/gateway-sources.js";

export type EngineKind = "searxng" | "gateway";
export type EngineSource = "default" | "local";

export interface EngineInfo {
  name: string;
  kind: EngineKind;
  enabled: boolean;
  available: boolean;
  routing: string[];
  requires?: string[];
  /** 仅 list --all：该引擎来自本地 settings.yml 还是 searxng 默认全量列表。 */
  source?: EngineSource;
}

export interface SetEnginesResult {
  changed: string[];
}

interface LocalState {
  config: LoadedDocument;
  configPath: string;
  secretsPath: string;
  secretsPlain: Record<string, unknown>;
  searxngSettingsPath: string;
  searxng: Array<{ name: string; enabled: boolean }>;
  resident: string[];
  rotating: string[];
  sources: GatewaySource[];
  searxngUrl: string;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function dig(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `secrets.gateway.token` → secrets.yaml 内的实际值。 */
function secretValue(secretsPlain: Record<string, unknown>, dotted: string): unknown {
  const path = dotted.split(".");
  if (path[0] !== "secrets") return undefined;
  return dig(secretsPlain, path.slice(1));
}

function hasSecret(secretsPlain: Record<string, unknown>, dotted: string): boolean {
  const value = secretValue(secretsPlain, dotted);
  return typeof value === "string" && value.trim().length > 0;
}

function loadLocalState(root: string): LocalState {
  const paths = rootPaths(root);
  if (!existsSync(paths.config)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到 gateway.yaml：${paths.config}`);
  }

  const config = readYamlDocument(paths.config);
  const plain = documentToPlain(config.doc);
  const search = asObject(plain.search);
  const engines = asObject(search.engines);
  const reverseImage = asObject(search.reverse_image);
  const secrets = readYamlDocument(paths.secrets);

  const resident = stringArray(engines.resident);
  const rotating = stringArray(engines.rotating);
  const rawSources = reverseImage.sources;
  // 文件省略 sources 时按 schema 默认值（全部启用）理解。
  const sources: GatewaySource[] = Array.isArray(rawSources)
    ? stringArray(rawSources).filter(isGatewaySource)
    : GATEWAY_SOURCE_SPECS.map((spec) => spec.name);

  let searxngUrl = "http://127.0.0.1:8888";
  try {
    searxngUrl = readEndpoints(root).searxngUrl;
  } catch {
    // gateway.yaml 已在上面成功解析；端口读取失败时保持默认值
  }

  return {
    config,
    configPath: paths.config,
    secretsPath: paths.secrets,
    secretsPlain: documentToPlain(secrets.doc),
    searxngSettingsPath: paths.searxngSettings,
    searxng: readSearxngEngines(paths.searxngSettings),
    resident,
    rotating,
    sources,
    searxngUrl,
  };
}

function routingFor(state: LocalState, name: string): string[] {
  if (state.resident.includes(name)) return ["resident"];
  if (state.rotating.includes(name)) return ["rotating"];
  return [];
}

/** 本地 searxng 引擎视图：settings.yml 条目 + 配置里引用但文件缺失的名字。 */
function localSearxngEngines(state: LocalState): EngineInfo[] {
  const result: EngineInfo[] = [];
  const seen = new Set<string>();

  for (const engine of state.searxng) {
    seen.add(engine.name);
    result.push({
      name: engine.name,
      kind: "searxng",
      enabled: engine.enabled,
      available: true,
      routing: routingFor(state, engine.name),
    });
  }

  for (const name of [...state.resident, ...state.rotating]) {
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      kind: "searxng",
      enabled: true,
      available: true,
      routing: routingFor(state, name),
    });
  }

  return result;
}

function gatewayEngines(state: LocalState): EngineInfo[] {
  return GATEWAY_SOURCE_SPECS.map((spec) => {
    const requires = [...spec.requires];
    const info: EngineInfo = {
      name: spec.name,
      kind: "gateway",
      enabled: state.sources.includes(spec.name),
      available: requires.every((path) => hasSecret(state.secretsPlain, path)),
      routing: ["source"],
    };
    if (requires.length > 0) info.requires = requires;
    return info;
  });
}

/** 本地视图：只读 gateway.yaml / secrets.yaml / settings.yml，离线可用。 */
export function readLocalEngines(root: string): EngineInfo[] {
  const state = loadLocalState(root);
  return [...localSearxngEngines(state), ...gatewayEngines(state)];
}

interface RemoteEngine {
  name: string;
  enabled: boolean;
}

async function fetchSearxngEngines(url: string): Promise<RemoteEngine[]> {
  let res: Response;
  try {
    res = await fetch(`${url}/config`, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    throw new CliError(
      "BACKEND_DOWN",
      EXIT.FAIL,
      `无法连接 searxng（${url}/config）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!res.ok) {
    throw new CliError("BACKEND_DOWN", EXIT.FAIL, `searxng /config 返回 HTTP ${res.status}`);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (error) {
    throw new CliError(
      "BACKEND_DOWN",
      EXIT.FAIL,
      `searxng /config 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const engines = (payload as { engines?: unknown })?.engines;
  if (!Array.isArray(engines)) return [];

  const result: RemoteEngine[] = [];
  for (const item of engines) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) continue;
    result.push({ name: record.name, enabled: record.enabled !== false });
  }
  return result;
}

/**
 * 本地列表；`all=true` 时叠加 searxng /config 的全量引擎（source=default）。
 * 本地条目始终以文件为准（source=local）。
 */
export async function listEngines(root: string, options: { all?: boolean } = {}): Promise<EngineInfo[]> {
  const state = loadLocalState(root);
  const local = [...localSearxngEngines(state), ...gatewayEngines(state)];
  if (!options.all) return local;

  const remote = await fetchSearxngEngines(state.searxngUrl);
  const known = new Set(local.filter((engine) => engine.kind === "searxng").map((engine) => engine.name));
  const merged = local.map((engine) =>
    engine.kind === "searxng" ? { ...engine, source: "local" as const } : engine,
  );

  for (const engine of remote) {
    if (known.has(engine.name)) continue;
    known.add(engine.name);
    merged.push({
      name: engine.name,
      kind: "searxng",
      enabled: engine.enabled,
      available: true,
      routing: routingFor(state, engine.name),
      source: "default",
    });
  }

  return merged;
}

/**
 * 批量启用/禁用：先全部校验（未知名字、缺 secret），任一失败不写任何文件；
 * 通过后再写 settings.yml 与 gateway.yaml，由调用方整栈重启一次。
 */
export function setEngines(
  root: string,
  names: readonly string[],
  enabled: boolean,
  options: { knownSearxng?: Iterable<string> } = {},
): SetEnginesResult {
  const requested = [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
  if (requested.length === 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "engines enable/disable 至少需要一个引擎名");
  }

  const state = loadLocalState(root);
  const knownSearxng = new Set([
    ...state.searxng.map((engine) => engine.name),
    ...state.resident,
    ...state.rotating,
    ...(options.knownSearxng ?? []),
  ]);

  const searxngTargets: string[] = [];
  const gatewayTargets: GatewaySource[] = [];
  const unknown: string[] = [];

  for (const name of requested) {
    if (isGatewaySource(name)) {
      gatewayTargets.push(name);
    } else if (knownSearxng.has(name)) {
      searxngTargets.push(name);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    throw new CliError("ENGINE_NOT_FOUND", EXIT.INVALID, `未知引擎：${unknown.join(", ")}`, {
      engines: unknown,
    });
  }

  if (enabled) {
    const missing: Array<{ engine: string; requires: string[] }> = [];
    for (const name of gatewayTargets) {
      const spec = gatewaySourceSpec(name);
      const requires = spec?.requires.filter((path) => !hasSecret(state.secretsPlain, path)) ?? [];
      if (requires.length > 0) missing.push({ engine: name, requires: [...requires] });
    }
    if (missing.length > 0) {
      const summary = missing
        .map((item) => `${item.engine} 需要 ${item.requires.join(", ")}`)
        .join("；");
      throw new CliError("MISSING_SECRET", EXIT.INVALID, `缺少密钥，拒绝启用：${summary}`, {
        missing,
      });
    }
  }

  // 网关源：从 sources 数组增删。
  const nextSources: GatewaySource[] = [...state.sources];
  if (enabled) {
    for (const name of gatewayTargets) {
      if (!nextSources.includes(name)) nextSources.push(name);
    }
  } else {
    for (const name of gatewayTargets) {
      const index = nextSources.indexOf(name);
      if (index !== -1) nextSources.splice(index, 1);
    }
  }

  const sourcesChanged =
    nextSources.length !== state.sources.length ||
    nextSources.some((name, index) => name !== state.sources[index]);
  if (sourcesChanged) {
    setYamlPath(state.config.doc, ["search", "reverse_image", "sources"], nextSources);
  }

  // 写入前校验；校验失败时两个文件都保持原样。
  const configText = sourcesChanged ? documentToText(state.config.doc) : undefined;
  if (configText !== undefined) {
    validateConfigTexts({ configText, secretsText: readTextIfExists(state.secretsPath) });
  }

  if (searxngTargets.length > 0) {
    writeSearxngEngineStates(
      state.searxngSettingsPath,
      searxngTargets.map((name) => ({ name, enabled })),
    );
  }
  if (configText !== undefined) {
    writeConfigFile(state.configPath, configText);
  }

  return { changed: requested };
}
