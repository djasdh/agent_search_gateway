/** CLI 统一错误类型与退出码。 */

export const EXIT = {
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  MISSING: 3,
  INVALID: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type ErrorCode =
  | "NOT_INSTALLED"
  | "START_FAILED"
  | "HEALTH_TIMEOUT"
  | "CONFIG_INVALID"
  | "SCHEMA_MISMATCH"
  | "MISSING_SECRET"
  | "ENGINE_NOT_FOUND"
  | "PLUGIN_UNKNOWN"
  | "PLUGIN_FAILED"
  | "BACKEND_DOWN"
  | "SERVICE_DOWN"
  | "DOWNLOAD_FAILED"
  | "BROWSER_NOT_INSTALLED"
  | "NODE_TOO_OLD"
  | "PYTHON_MISSING"
  | "PORT_IN_USE"
  | "SERVICE_NOT_REGISTERED"
  | "UPDATE_FAILED"
  | "UPDATE_ROLLED_BACK"
  | "NOT_IMPLEMENTED"
  | "UNEXPECTED";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, exitCode: ExitCode, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("UNEXPECTED", EXIT.FAIL, message);
}
