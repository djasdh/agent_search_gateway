/** 三个后端共用的失败映射：CLI 信封、CLI 退出码、HTTP 状态与信封都收敛到 BiliError。 */

import { BiliError, type BiliErrorCode, type CliResult } from "./types.js";
import { asRecord, str, type Json } from "./json.js";

const AUTH_ALIASES = new Set([
  "not_logged_in",
  "not_authenticated",
  "auth_expired",
  "login_pending",
  "login_expired",
  "auth_required",
  "BILI_AUTH_REQUIRED",
]);

const RISK_ALIASES = new Set([
  "risk_control",
  "captcha_required",
  "rate_limited",
  "risk",
  "BILI_RISK_CONTROL",
]);

const KNOWN: ReadonlySet<string> = new Set([
  "BILI_UNAVAILABLE",
  "BILI_AUTH_REQUIRED",
  "BILI_CAPABILITY_UNSUPPORTED",
  "BILI_RISK_CONTROL",
  "BILI_DOWNLOAD_FAIL",
  "BILI_INVALID_URL",
  "BILI_PARTIAL",
]);

/** 把外部错误码归一成 BILI_*；认不出的返回 undefined。 */
export function normalizeCode(raw: string | undefined): BiliErrorCode | undefined {
  if (!raw) return undefined;
  if (AUTH_ALIASES.has(raw)) return "BILI_AUTH_REQUIRED";
  if (RISK_ALIASES.has(raw)) return "BILI_RISK_CONTROL";
  return KNOWN.has(raw) ? (raw as BiliErrorCode) : undefined;
}

/** 解析 {"code","message","hint"} 形式的错误体。 */
export function errorFromEnvelope(raw: unknown, what: string): BiliError {
  const body = asRecord(raw) ?? {};
  const code = normalizeCode(str(body, "code")) ?? "BILI_UNAVAILABLE";
  const message = str(body, "message") ?? str(body, "msg") ?? `${what} 失败`;
  return new BiliError(code, message, str(body, "hint"));
}

/** CLI 失败：先看 spawn 错误与超时，再看 stderr 里的登录/风控特征。 */
export function cliFailure(result: CliResult, command: string, what: string): BiliError {
  if (result.spawnError === "ENOENT") {
    return new BiliError(
      "BILI_UNAVAILABLE",
      `spawn ${command} ENOENT`,
      `安装 ${command} 或修改 bilibili 配置里的命令路径`,
    );
  }
  if (result.timedOut) {
    return new BiliError("BILI_UNAVAILABLE", `${what}：命令超时（${command}）`);
  }
  const detail = result.stderr.trim().slice(-300);
  const probe = detail.toLowerCase();
  if (/login|not_logged|未登录|-101/.test(probe)) {
    return new BiliError("BILI_AUTH_REQUIRED", `${what}：需要登录`, detail || undefined);
  }
  if (/412|403|risk|风控|验证码/.test(probe)) {
    return new BiliError("BILI_RISK_CONTROL", `${what}：被 B 站风控拦截`, detail || undefined);
  }
  return new BiliError(
    "BILI_UNAVAILABLE",
    `${what}：${command} 退出码 ${result.exitCode ?? "unknown"}${detail ? `（${detail}）` : ""}`,
  );
}

/** HTTP 失败：状态码优先，其次后端信封里的业务码。 */
export function httpFailure(status: number, body: unknown, what: string): BiliError {
  if (status === 401 || status === 403) {
    return new BiliError("BILI_AUTH_REQUIRED", `${what}：HTTP ${status}`);
  }
  if (status === 412) {
    return new BiliError("BILI_RISK_CONTROL", `${what}：HTTP 412`);
  }
  const envelope = asRecord(body);
  if (envelope?.ok === false) return errorFromEnvelope(envelope.error, what);
  const code = normalizeCode(str(envelope, "code"));
  const message = str(envelope, "message") ?? str(envelope, "msg") ?? `${what}：HTTP ${status}`;
  if (code) return new BiliError(code, message, str(envelope, "hint"));
  return new BiliError("BILI_UNAVAILABLE", message);
}

/** 供后端判断"这个错误体是不是业务失败信封"。 */
export function envelopeError(body: Json): BiliError | undefined {
  if (body.ok !== false) return undefined;
  return errorFromEnvelope(body.error, "后端");
}
