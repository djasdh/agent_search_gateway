/**
 * searxng 存储适配器：真值是 `data/deps/searxng/settings.yml` 的 `engines[].disabled`。
 *
 * `listAll` 才联网请求 `/config`，失败统一报 BACKEND_DOWN。
 */

import { CliError, EXIT } from "../../errors.js";
import { renderSearxngEngineStates } from "../../config/searxng.js";
import { routingFor, stringArray, asObject } from "../shared.js";
import type { EngineChange, EngineContext, EngineGroup, EnginePlan, EngineRecord, EngineStore } from "../types.js";

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

function localRecords(ctx: EngineContext): EngineRecord[] {
  const result: EngineRecord[] = [];
  const seen = new Set<string>();

  for (const engine of ctx.searxng) {
    seen.add(engine.name);
    result.push({
      id: `searxng:${engine.name}`,
      group: "searxng",
      name: engine.name,
      kind: "searxng",
      enabled: engine.enabled,
      available: true,
      routing: routingFor(ctx.configPlain, engine.name),
    });
  }

  const engines = asObject(asObject(ctx.configPlain.search).engines);
  for (const name of [...stringArray(engines.resident), ...stringArray(engines.rotating)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({
      id: `searxng:${name}`,
      group: "searxng",
      name,
      kind: "searxng",
      enabled: true,
      available: true,
      routing: routingFor(ctx.configPlain, name),
    });
  }

  return result;
}

export class SearxngStore implements EngineStore {
  readonly id = "searxng";
  readonly groups: readonly EngineGroup[] = ["searxng"];

  list(ctx: EngineContext): EngineRecord[] {
    return localRecords(ctx);
  }

  async listAll(ctx: EngineContext): Promise<EngineRecord[]> {
    const local: EngineRecord[] = localRecords(ctx).map((engine) => ({
      ...engine,
      source: "local" as const,
    }));
    const remote = await fetchSearxngEngines(ctx.searxngUrl);

    const known = new Set(local.map((engine) => engine.name));
    for (const engine of remote) {
      if (known.has(engine.name)) continue;
      known.add(engine.name);
      local.push({
        id: `searxng:${engine.name}`,
        group: "searxng",
        name: engine.name,
        kind: "searxng",
        enabled: engine.enabled,
        available: true,
        routing: routingFor(ctx.configPlain, engine.name),
        source: "default",
      });
    }

    return local;
  }

  plan(changes: readonly EngineChange[], ctx: EngineContext): EnginePlan {
    const own = changes.filter((change) => change.group === "searxng");
    if (own.length === 0) return { changed: [], writes: [] };

    const rendered = renderSearxngEngineStates(
      ctx.paths.searxngSettings,
      own.map((change) => ({ name: change.name, enabled: change.enabled })),
    );

    return {
      changed: rendered.changed.map((name) => `searxng:${name}`),
      writes: rendered.text === undefined ? [] : [{ path: ctx.paths.searxngSettings, text: rendered.text }],
    };
  }
}
