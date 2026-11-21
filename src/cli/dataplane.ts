/**
 * `asg search` / `asg fetch` 的只读数据面客户端。
 *
 * CLI 不重新实现搜索/抓取：它只以 MCP 客户端身份调用运行中的网关，
 * 因此测到的是当前配置、插件与运行期状态。命令本身不写配置、不重启服务。
 */

import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadSettings } from "../settings/index.js";
import { CliError, EXIT } from "./errors.js";
import { rootPaths, version } from "./root.js";

export type GatewayToolName = "search" | "fetch";

export interface GatewayToolResult {
  tool: GatewayToolName;
  endpoint: string;
  text: string;
  isError: boolean;
  elapsedMs: number;
}

export interface DataPlaneEndpoint {
  endpoint: string;
  token: string;
}

export interface ToolFailure {
  code: string;
  message: string;
}

/** `0.0.0.0` / `::` 是监听地址，CLI 需要换成本机可连的地址。 */
function connectHost(host: string): string {
  const value = host.trim();
  if (value === "" || value === "0.0.0.0") return "127.0.0.1";
  if (value === "::" || value === "[::]") return "::1";
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
}

function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 从安装根的 gateway.yaml / secrets.yaml 解析 MCP endpoint 与 token。 */
export function resolveDataPlane(root: string): DataPlaneEndpoint {
  const paths = rootPaths(root);
  if (!existsSync(paths.config)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到 gateway.yaml：${paths.config}`);
  }

  let loaded;
  try {
    loaded = loadSettings({ configPath: paths.config, secretsPath: paths.secrets });
  } catch (error) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, `读取网关配置失败：${describe(error)}`, {
      config: paths.config,
      secrets: paths.secrets,
    });
  }

  const host = connectHost(loaded.settings.gateway.host);
  const endpoint = `http://${hostForUrl(host)}:${loaded.settings.gateway.port}/mcp`;
  return { endpoint, token: loaded.secrets.gateway.token };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
  }
  return parts.join("\n");
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) return error.code === 401 || error.code === 403;
  return error instanceof Error && error.name === "UnauthorizedError";
}

function mapTransportError(error: unknown, endpoint: string): CliError {
  if (error instanceof CliError) return error;

  if (isUnauthorized(error)) {
    return new CliError(
      "GATEWAY_UNAUTHORIZED",
      EXIT.FAIL,
      `网关鉴权失败（${endpoint}）：检查 secrets.yaml 的 gateway.token，或当前 shell 的 GATEWAY_TOKEN。`,
      { endpoint },
    );
  }

  if (error instanceof StreamableHTTPError) {
    return new CliError(
      "SERVICE_DOWN",
      EXIT.FAIL,
      `MCP 调用失败（HTTP ${error.code ?? "?"}，${endpoint}）：${error.message}`,
      { endpoint },
    );
  }

  const message = describe(error);
  if (/timeout|timed out|请求超时/i.test(message)) {
    return new CliError(
      "SERVICE_DOWN",
      EXIT.FAIL,
      `调用网关超时（${endpoint}）：${message}。可用 --timeout 调大超时。`,
      { endpoint },
    );
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|connect/i.test(message)) {
    return new CliError(
      "SERVICE_DOWN",
      EXIT.FAIL,
      `无法连接网关（${endpoint}）：${message}。请确认网关已启动（asg start）。`,
      { endpoint },
    );
  }
  return new CliError(
    "SERVICE_DOWN",
    EXIT.FAIL,
    `调用网关失败（${endpoint}）：${message}`,
    { endpoint },
  );
}

/** 调用一次 MCP 工具；连接、调用、关闭都在本函数内完成。 */
export async function callGatewayTool(
  root: string,
  tool: GatewayToolName,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<GatewayToolResult> {
  const { endpoint, token } = resolveDataPlane(root);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    ...(token
      ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
      : {}),
  });
  const client = new Client(
    { name: "agent-search-gateway-cli", version: version(root) },
    { capabilities: {} },
  );

  const startedAt = Date.now();
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: timeoutMs,
    });
    return {
      tool,
      endpoint,
      text: textOf(result.content),
      isError: result.isError === true,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    throw mapTransportError(error, endpoint);
  } finally {
    try {
      await client.close();
    } catch {
      // 连接失败时 close 也可能失败；原始错误更重要。
    }
  }
}

/** 工具文本以 `[CODE]` 开头时拆出错误码，否则用命令级兜底码。 */
export function parseToolFailure(text: string, fallbackCode: string): ToolFailure {
  const match = /^\[([A-Z][A-Z0-9_]*)\]\s*/.exec(text);
  if (!match) return { code: fallbackCode, message: text };
  const message = text.slice(match[0].length);
  return { code: match[1]!, message: message.length > 0 ? message : text };
}

/**
 * 兼容旧网关：0.3.5 及以前的 MCP 工具不返回 `isError`，错误只体现在 `[CODE]` 前缀。
 * 只识别数据面错误码前缀，避免把抓取到的正文（如以 `[INFO]` 开头的文本）误判为失败。
 */
const DATA_PLANE_ERROR_PREFIXES = [
  "SEARCH_",
  "FETCH_",
  "BROWSER_",
] as const;

export function looksLikeToolFailure(text: string): boolean {
  const match = /^\[([A-Z][A-Z0-9_]*)\]/.exec(text);
  if (!match) return false;
  return DATA_PLANE_ERROR_PREFIXES.some((prefix) => match[1]!.startsWith(prefix));
}
