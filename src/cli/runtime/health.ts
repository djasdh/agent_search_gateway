/** /health 与后端探针：所有探测都带超时，失败折算成结构化结果而非异常。 */

import { gatewayHealthUrl } from "../ports.js";

export interface ServiceProbe {
  up: boolean;
  latency_ms?: number;
  error?: string;
  version?: string;
  uptime_s?: number;
}

export interface BackendHealth {
  status?: unknown;
  latencyMs?: unknown;
  error?: unknown;
}

export interface GatewayHealthReport {
  gateway?: { version?: unknown; uptimeSec?: unknown; uptime_s?: unknown };
  searxng?: unknown;
  flaresolverr?: unknown;
}

export interface GatewayProbeResult {
  probe: ServiceProbe;
  body: GatewayHealthReport | null;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 2000;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { code?: unknown; name?: unknown; cause?: unknown };
  if (typeof record.code === "string" && record.code) return record.code;
  if (record.name === "TimeoutError" || record.name === "AbortError") return "ETIMEDOUT";
  if (record.cause !== undefined && record.cause !== error) {
    const nested = errorCode(record.cause);
    if (nested) return nested;
  }
  return undefined;
}

/** 把 fetch 异常压成契约里的 error 字符串（例如 ECONNREFUSED / ETIMEDOUT）。 */
export function describeError(error: unknown): string {
  const code = errorCode(error);
  if (code) return code;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    // AbortSignal.timeout 同时约束响应头与响应体读取。
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    redirect: "manual",
    // 探测是一次性的：不复用连接，避免 keep-alive socket 拖住 CLI/supervisor 退出。
    headers: { connection: "close", ...(headers ?? {}) },
  });
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // 状态码仍可作为判断依据。
  }
}

/** 通用探针：GET 一个 URL，2xx 视为 up（3xx 不跟随）。 */
export async function probeUrl(url: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ServiceProbe> {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    const latency = Date.now() - started;
    await drain(response);
    if (!response.ok) {
      return { up: false, latency_ms: latency, error: `HTTP ${response.status}` };
    }
    return { up: true, latency_ms: latency };
  } catch (error) {
    return {
      up: false,
      latency_ms: Date.now() - started,
      error: describeError(error),
    };
  }
}

function parseGatewayBody(text: string): GatewayHealthReport | null {
  try {
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data as GatewayHealthReport;
  } catch {
    return null;
  }
}

/** gateway /health：一次取得版本、运行时长和两个后端状态。 */
export async function probeGateway(
  port: number,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<GatewayProbeResult> {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(gatewayHealthUrl(port), timeoutMs, {
      accept: "application/json",
    });
    const text = await response.text().catch(() => "");
    const latency = Date.now() - started;
    if (!response.ok) {
      return {
        probe: { up: false, latency_ms: latency, error: `HTTP ${response.status}` },
        body: null,
      };
    }

    const body = parseGatewayBody(text);
    const probe: ServiceProbe = { up: true, latency_ms: latency };
    const gateway = body?.gateway;
    if (gateway && typeof gateway.version === "string") probe.version = gateway.version;
    const uptime = gateway?.uptimeSec ?? gateway?.uptime_s;
    if (typeof uptime === "number" && Number.isFinite(uptime)) {
      probe.uptime_s = Math.max(0, Math.floor(uptime));
    }
    return { probe, body };
  } catch (error) {
    return {
      probe: {
        up: false,
        latency_ms: Date.now() - started,
        error: describeError(error),
      },
      body: null,
    };
  }
}

/** 把 gateway /health 里的后端条目映射为探针；结构不符时返回 null 让调用方回退直探。 */
export function probeFromHealth(value: unknown): ServiceProbe | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as BackendHealth;
  const status = entry.status;
  const up = status === "up" || status === "ok" || status === true;
  const down = status === "down" || status === "error" || status === false;
  if (!up && !down) return null;

  const probe: ServiceProbe = { up };
  if (typeof entry.latencyMs === "number" && Number.isFinite(entry.latencyMs)) {
    probe.latency_ms = Math.max(0, Math.round(entry.latencyMs));
  }
  if (!up) {
    probe.error = typeof entry.error === "string" && entry.error ? entry.error : "down";
  }
  return probe;
}
