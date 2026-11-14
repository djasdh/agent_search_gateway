/** 只读端口/URL：给 status 与探针用，失败时回退默认值。 */

import fs from "node:fs";
import YAML from "yaml";
import { rootPaths } from "./root.js";

export interface Endpoints {
  gatewayPort: number;
  searxngUrl: string;
  flaresolverrUrl: string;
  warnings: string[];
}

const DEFAULTS = {
  gatewayPort: 3000,
  searxngUrl: "http://127.0.0.1:8888",
  flaresolverrUrl: "http://127.0.0.1:8192",
};

export function readEndpoints(root: string): Endpoints {
  const warnings: string[] = [];
  const file = rootPaths(root).config;
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    warnings.push(`读取 gateway.yaml 失败，使用默认值：${error instanceof Error ? error.message : String(error)}`);
    return { ...DEFAULTS, warnings };
  }

  const doc = (raw ?? {}) as Record<string, unknown>;
  const gateway = (doc.gateway ?? {}) as Record<string, unknown>;
  const searxng = (doc.searxng ?? {}) as Record<string, unknown>;
  const flaresolverr = (doc.flaresolverr ?? {}) as Record<string, unknown>;

  const gatewayPort =
    typeof gateway.port === "number" && Number.isInteger(gateway.port) && gateway.port > 0
      ? gateway.port
      : DEFAULTS.gatewayPort;
  const searxngUrl =
    typeof searxng.url === "string" && searxng.url.trim() ? searxng.url.replace(/\/+$/, "") : DEFAULTS.searxngUrl;
  const flaresolverrUrl =
    typeof flaresolverr.url === "string" && flaresolverr.url.trim()
      ? flaresolverr.url.replace(/\/+$/, "")
      : DEFAULTS.flaresolverrUrl;

  return { gatewayPort, searxngUrl, flaresolverrUrl, warnings };
}

export function gatewayHealthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}
