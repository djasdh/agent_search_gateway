/**
 * gateway.yaml 存储适配器：以图搜图源（search.reverse_image.sources）、
 * `gateway.search` 扩展源（路由 / 开关）与 `gateway.upstream` 通用上游（开关）。
 *
 * 引擎元数据（名称 / 可用性 / routing / requires）来自 `src/engines/registry.ts`；
 * 平台能力由外部扩展提供，扩展私有配置走 `extensions.<id>.config`，核心不内置实现。
 */

import { documentToText, setYamlPath } from "../../config/gateway.js";
import {
  GATEWAY_SOURCE_SPECS,
  isGatewaySource,
  type GatewaySource,
} from "../../../settings/gateway-sources.js";
import { engineProvider, providersForGroup } from "../../../engines/registry.js";
import type { EngineProviderContext } from "../../../engines/provider.js";
import { asObject, stringArray } from "../shared.js";
import type { EngineChange, EngineContext, EngineGroup, EnginePlan, EngineRecord, EngineStore } from "../types.js";

function currentSources(ctx: EngineContext): GatewaySource[] {
  const reverseImage = asObject(asObject(ctx.configPlain.search).reverse_image);
  // 文件省略 sources 时按 schema 默认值（全部启用）理解。
  if (!Array.isArray(reverseImage.sources)) return GATEWAY_SOURCE_SPECS.map((spec) => spec.name);
  return stringArray(reverseImage.sources).filter(isGatewaySource);
}

function missingProvider(id: string): never {
  throw new Error(`缺少内置引擎 provider：${id}`);
}

function reverseImageRecords(ctx: EngineContext, providerCtx: EngineProviderContext): EngineRecord[] {
  const sources = currentSources(ctx);
  return providersForGroup("gateway.reverse_image").map((provider) => {
    const record: EngineRecord = {
      id: provider.id,
      group: provider.group,
      name: provider.name,
      kind: provider.kind,
      enabled: sources.includes(provider.name as GatewaySource),
      available: provider.available(providerCtx),
      routing: provider.routing(providerCtx),
    };
    if (provider.requires && provider.requires.length > 0) record.requires = [...provider.requires];
    if (provider.pluginId) record.pluginId = provider.pluginId;
    return record;
  });
}

/** gateway.search 与 gateway.upstream 的启用状态来自 provider.enabled（缺省 true）。 */
function gatewayProviderRecords(
  group: "gateway.search" | "gateway.upstream",
  providerCtx: EngineProviderContext,
): EngineRecord[] {
  return providersForGroup(group).map((provider) => {
    const record: EngineRecord = {
      id: provider.id,
      group: provider.group,
      name: provider.name,
      kind: provider.kind,
      enabled: provider.enabled?.(providerCtx) ?? true,
      available: provider.available(providerCtx),
      routing: provider.routing(providerCtx),
    };
    if (provider.requires && provider.requires.length > 0) record.requires = [...provider.requires];
    if (provider.pluginId) record.pluginId = provider.pluginId;
    return record;
  });
}

export class GatewayStore implements EngineStore {
  readonly id = "gateway.yaml";
  readonly groups: readonly EngineGroup[] = [
    "gateway.reverse_image",
    "gateway.search",
    "gateway.upstream",
  ];

  list(ctx: EngineContext): EngineRecord[] {
    const providerCtx: EngineProviderContext = { config: ctx.configPlain, secrets: ctx.secrets };
    return [
      ...reverseImageRecords(ctx, providerCtx),
      ...gatewayProviderRecords("gateway.search", providerCtx),
      ...gatewayProviderRecords("gateway.upstream", providerCtx),
    ];
  }

  plan(changes: readonly EngineChange[], ctx: EngineContext): EnginePlan {
    const changed: string[] = [];

    const reverseChanges = changes.filter((change) => change.group === "gateway.reverse_image");
    if (reverseChanges.length > 0) {
      const base = currentSources(ctx);
      const next = [...base];
      for (const change of reverseChanges) {
        const index = next.indexOf(change.name as GatewaySource);
        if (change.enabled) {
          if (index === -1) {
            next.push(change.name as GatewaySource);
            changed.push(`gateway.reverse_image:${change.name}`);
          }
        } else if (index !== -1) {
          next.splice(index, 1);
          changed.push(`gateway.reverse_image:${change.name}`);
        }
      }

      const same = next.length === base.length && next.every((name, index) => name === base[index]);
      if (!same) setYamlPath(ctx.config.doc, ["search", "reverse_image", "sources"], next);
    }

    const providerCtx: EngineProviderContext = { config: ctx.configPlain, secrets: ctx.secrets };
    const gatewayChanges = changes.filter(
      (change) => change.group === "gateway.search" || change.group === "gateway.upstream",
    );
    for (const change of gatewayChanges) {
      const provider =
        engineProvider(change.group, change.name) ??
        missingProvider(`${change.group}:${change.name}`);
      if (!provider.enabledPath) {
        throw new Error(`引擎 provider 缺少 enabledPath：${provider.id}`);
      }
      const current = provider.enabled?.(providerCtx) ?? true;
      if (current === change.enabled) continue;
      setYamlPath(ctx.config.doc, [...provider.enabledPath], change.enabled);
      changed.push(provider.id);
    }

    if (changed.length === 0) return { changed: [], writes: [] };

    return {
      changed,
      writes: [{ path: ctx.paths.config, text: documentToText(ctx.config.doc) }],
    };
  }
}
