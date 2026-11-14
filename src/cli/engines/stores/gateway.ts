/**
 * gateway.yaml 存储适配器：以图搜图源（search.reverse_image.sources）与微博文本源
 * （search.weibo.enabled）。
 *
 * 顶层 `weibo.enabled` 是运行能力开关，归 `asg config`，引擎命令只读不写。
 */

import { documentToText, setYamlPath } from "../../config/gateway.js";
import {
  GATEWAY_SOURCE_SPECS,
  isGatewaySource,
  type GatewaySource,
} from "../../../settings/gateway-sources.js";
import { asObject, dig, nonEmptyString, stringArray } from "../shared.js";
import type { EngineChange, EngineContext, EngineGroup, EnginePlan, EngineRecord, EngineStore } from "../types.js";

function hasSecret(secrets: Record<string, unknown>, dotted: string): boolean {
  const path = dotted.split(".");
  if (path[0] !== "secrets") return false;
  const value = dig(secrets, path.slice(1));
  return typeof value === "string" && value.trim().length > 0;
}

function currentSources(ctx: EngineContext): GatewaySource[] {
  const reverseImage = asObject(asObject(ctx.configPlain.search).reverse_image);
  // 文件省略 sources 时按 schema 默认值（全部启用）理解。
  if (!Array.isArray(reverseImage.sources)) return GATEWAY_SOURCE_SPECS.map((spec) => spec.name);
  return stringArray(reverseImage.sources).filter(isGatewaySource);
}

function reverseImageRecords(ctx: EngineContext): EngineRecord[] {
  const sources = currentSources(ctx);
  return GATEWAY_SOURCE_SPECS.map((spec) => {
    const requires = [...spec.requires];
    const record: EngineRecord = {
      id: `gateway.reverse_image:${spec.name}`,
      group: "gateway.reverse_image",
      name: spec.name,
      kind: "gateway",
      enabled: sources.includes(spec.name),
      available: requires.every((path) => hasSecret(ctx.secrets, path)),
      routing: ["source"],
    };
    if (requires.length > 0) record.requires = requires;
    return record;
  });
}

function weiboRecord(ctx: EngineContext): EngineRecord {
  const search = asObject(ctx.configPlain.search);
  const searchWeibo = asObject(search.weibo);
  const topWeibo = asObject(ctx.configPlain.weibo);
  const category = nonEmptyString(searchWeibo.category) ?? "weibo";
  const hotCategory = nonEmptyString(searchWeibo.hot_category) ?? "weibo_hot";
  const rawCommand = asObject(topWeibo.cli).command;
  // 只有「缺省」才回落到 opencli；显式空串表示未配置可用命令。
  const command =
    rawCommand === undefined ? "opencli" : typeof rawCommand === "string" ? rawCommand.trim() : "";

  return {
    id: "gateway.search:weibo",
    group: "gateway.search",
    name: "weibo",
    kind: "gateway",
    enabled: searchWeibo.enabled === true,
    available: topWeibo.enabled === true && command.length > 0,
    routing: [`category:${category}`, `category:${hotCategory}`],
    requires: ["config:weibo.enabled"],
  };
}

export class GatewayStore implements EngineStore {
  readonly id = "gateway.yaml";
  readonly groups: readonly EngineGroup[] = ["gateway.reverse_image", "gateway.search"];

  list(ctx: EngineContext): EngineRecord[] {
    return [...reverseImageRecords(ctx), weiboRecord(ctx)];
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

    const searchChanges = changes.filter((change) => change.group === "gateway.search");
    for (const change of searchChanges) {
      if (change.name !== "weibo") continue;
      const current = asObject(asObject(ctx.configPlain.search).weibo).enabled === true;
      if (current === change.enabled) continue;
      setYamlPath(ctx.config.doc, ["search", "weibo", "enabled"], change.enabled);
      changed.push("gateway.search:weibo");
    }

    if (changed.length === 0) return { changed: [], writes: [] };

    return {
      changed,
      writes: [{ path: ctx.paths.config, text: documentToText(ctx.config.doc) }],
    };
  }
}
