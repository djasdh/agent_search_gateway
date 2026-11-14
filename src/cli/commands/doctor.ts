/** asg doctor：只读环境与配置检查。
 *
 * 每项检查独立执行，失败不中断后续检查；所有失败汇总后由命令层决定退出码。
 * 有 error 级失败 → 退出码 1；warn 级失败不影响退出码。
 */

import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { loadSettings } from "../../settings/load.js";
import type { CommandFn } from "../context.js";
import { browserStatus, type BrowserStatus } from "../deps/browser.js";
import { CliError, EXIT } from "../errors.js";
import { detectManager, type ManagerDetection } from "../platform/index.js";
import { readEndpoints } from "../ports.js";
import { exists, readCurrent, rootPaths, type CurrentState } from "../root.js";
import { probeGateway } from "../runtime/health.js";
import { loadLaunchConfig } from "../runtime/launch.js";
import { probeStack, type StackStatus } from "../runtime/stack.js";

export type DoctorLevel = "error" | "warn";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  level: DoctorLevel;
  /** 失败时的错误码（SERVICE_DOWN 等仅用于 doctor 的提示码）。 */
  code?: string;
  message?: string;
}

export interface PortProbe {
  port: number;
  /** gateway：本网关在监听；other：端口被其他进程占用；free：端口空闲。 */
  state: "gateway" | "other" | "free";
}

export interface PythonProbe {
  ok: boolean;
  version?: string;
  message?: string;
}

export interface DoctorDeps {
  nodeVersion?: string;
  readCurrent?: (root: string) => CurrentState;
  python?: () => PythonProbe;
  probePort?: (root: string) => Promise<PortProbe>;
  detect?: (root: string) => ManagerDetection;
  browser?: () => BrowserStatus;
  probe?: (root: string) => Promise<StackStatus>;
  /** 密钥环境变量覆盖；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
}

const MIN_NODE = "20.18.1";
const MIN_PYTHON = [3, 10] as const;
const SERVICE_NAMES = ["gateway", "searxng", "flaresolverr"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function versionParts(value: string): number[] {
  return String(value)
    .replace(/^v/i, "")
    .split("-")[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let i = 0; i < Math.max(left.length, right.length, 3); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** searxng 是否以 native 方式运行：launch.json 含 searxng 服务，或存在 venv。 */
function searxngIsNative(root: string): boolean {
  try {
    const config = loadLaunchConfig(root);
    if (config.services.some((service) => service.name === "searxng")) return true;
  } catch {
    // launch.json 的问题由单独检查报告。
  }
  return exists(path.join(root, "data", "deps", "searxng", "venv"));
}

function defaultPythonProbe(): PythonProbe {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  const seen = new Set<string>();
  let foundVersion: string | null = null;

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const result = spawnSync(
      candidate,
      ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    if (result.error) continue;
    const version = (result.stdout || "").trim();
    if (!version) continue;
    if (!foundVersion) foundVersion = version;
    if (result.status === 0 && versionAtLeast(version, MIN_PYTHON.join("."))) {
      return { ok: true, version };
    }
  }

  return {
    ok: false,
    ...(foundVersion ? { version: foundVersion } : {}),
    message: foundVersion
      ? `Python ${foundVersion} 低于 ${MIN_PYTHON.join(".")}`
      : `未找到 Python ${MIN_PYTHON.join(".")}+`,
  };
}

function tcpOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function defaultProbePort(root: string): Promise<PortProbe> {
  const { gatewayPort } = readEndpoints(root);
  const gateway = await probeGateway(gatewayPort, 1000);
  if (gateway.probe.up) return { port: gatewayPort, state: "gateway" };
  if (await tcpOpen(gatewayPort)) return { port: gatewayPort, state: "other" };
  return { port: gatewayPort, state: "free" };
}

function checkInstallation(root: string, deps: DoctorDeps): DoctorCheck {
  try {
    const current = (deps.readCurrent ?? readCurrent)(root);
    if (!exists(current.dir)) {
      return {
        name: "installation",
        ok: false,
        level: "error",
        code: "NOT_INSTALLED",
        message: `版本目录不存在：${current.dir}`,
      };
    }
    return { name: "installation", ok: true, level: "error", message: `版本目录 ${current.dir}` };
  } catch (error) {
    const code = error instanceof CliError ? error.code : "NOT_INSTALLED";
    return {
      name: "installation",
      ok: false,
      level: "error",
      code: code === "SCHEMA_MISMATCH" ? "SCHEMA_MISMATCH" : "NOT_INSTALLED",
      message: errorMessage(error),
    };
  }
}

function checkNode(deps: DoctorDeps): DoctorCheck {
  const version = deps.nodeVersion ?? process.versions.node;
  if (versionAtLeast(version, MIN_NODE)) {
    return { name: "node", ok: true, level: "error", message: `Node ${version}` };
  }
  return {
    name: "node",
    ok: false,
    level: "error",
    code: "NODE_TOO_OLD",
    message: `Node ${version} 低于 ${MIN_NODE}`,
  };
}

function checkPython(root: string, deps: DoctorDeps): DoctorCheck {
  if (!searxngIsNative(root)) {
    return {
      name: "python",
      ok: true,
      level: "warn",
      message: "searxng 非 native 模式，跳过 Python 检查",
    };
  }

  try {
    const probe = (deps.python ?? defaultPythonProbe)();
    if (probe.ok) {
      return { name: "python", ok: true, level: "warn", message: `Python ${probe.version ?? ""}`.trim() };
    }
    return {
      name: "python",
      ok: false,
      level: "warn",
      code: "PYTHON_MISSING",
      message: probe.message ?? "未找到 Python 3.10+",
    };
  } catch (error) {
    return {
      name: "python",
      ok: false,
      level: "warn",
      code: "PYTHON_MISSING",
      message: errorMessage(error),
    };
  }
}

function checkConfig(
  root: string,
  deps: DoctorDeps,
): { check: DoctorCheck; tokenConfigured: boolean | null; flaresolverrEnabled: boolean } {
  try {
    const paths = rootPaths(root);
    const loaded = loadSettings({
      configPath: paths.config,
      secretsPath: paths.secrets,
      ...(deps.env ? { env: deps.env } : {}),
    });
    const token = loaded.secrets.gateway.token.trim();
    return {
      check: {
        name: "config",
        ok: true,
        level: "error",
        message: `已解析 ${path.basename(paths.config)} 与 ${path.basename(paths.secrets)}`,
      },
      tokenConfigured: token !== "",
      flaresolverrEnabled: loaded.settings.flaresolverr.enabled,
    };
  } catch (error) {
    return {
      check: {
        name: "config",
        ok: false,
        level: "error",
        code: "CONFIG_INVALID",
        message: errorMessage(error),
      },
      tokenConfigured: null,
      flaresolverrEnabled: true,
    };
  }
}

function checkToken(tokenConfigured: boolean | null): DoctorCheck {
  if (tokenConfigured === null) {
    return {
      name: "gateway_token",
      ok: false,
      level: "warn",
      code: "MISSING_SECRET",
      message: "配置不可解析，无法确认 gateway.token",
    };
  }
  if (tokenConfigured) {
    return { name: "gateway_token", ok: true, level: "warn", message: "已配置" };
  }
  return {
    name: "gateway_token",
    ok: false,
    level: "warn",
    code: "MISSING_SECRET",
    message: "secrets.gateway.token 为空；HTTP MCP 将不启用鉴权",
  };
}

function checkLaunch(root: string): DoctorCheck {
  try {
    const config = loadLaunchConfig(root);
    return {
      name: "launch",
      ok: true,
      level: "error",
      message: `${config.services.length} 个服务`,
    };
  } catch (error) {
    return {
      name: "launch",
      ok: false,
      level: "error",
      code: "SCHEMA_MISMATCH",
      message: errorMessage(error),
    };
  }
}

async function checkPort(root: string, deps: DoctorDeps): Promise<DoctorCheck> {
  try {
    const probe = await (deps.probePort ?? defaultProbePort)(root);
    if (probe.state === "gateway") {
      return {
        name: "port",
        ok: true,
        level: "warn",
        message: `端口 ${probe.port} 由本网关监听`,
      };
    }
    if (probe.state === "free") {
      return { name: "port", ok: true, level: "warn", message: `端口 ${probe.port} 空闲` };
    }
    return {
      name: "port",
      ok: false,
      level: "warn",
      code: "PORT_IN_USE",
      message: `端口 ${probe.port} 已被其他进程占用`,
    };
  } catch (error) {
    return {
      name: "port",
      ok: false,
      level: "warn",
      code: "PORT_IN_USE",
      message: `端口检查失败：${errorMessage(error)}`,
    };
  }
}

function checkManager(root: string, deps: DoctorDeps): DoctorCheck {
  try {
    const detection = (deps.detect ?? ((target: string) => detectManager(target)))(root);
    if (detection.registered) {
      return {
        name: "service_manager",
        ok: true,
        level: "warn",
        message: `${detection.mode}（${detection.active ? "active" : "inactive"}）`,
      };
    }
    return {
      name: "service_manager",
      ok: false,
      level: "warn",
      code: "SERVICE_NOT_REGISTERED",
      message: `未注册服务管理器（回退模式：${detection.mode}）`,
    };
  } catch (error) {
    return {
      name: "service_manager",
      ok: false,
      level: "warn",
      code: "SERVICE_NOT_REGISTERED",
      message: errorMessage(error),
    };
  }
}

function checkBrowser(deps: DoctorDeps): DoctorCheck {
  try {
    const status = (deps.browser ?? (() => browserStatus()))();
    if (status.headless_shell || status.chromium) {
      return {
        name: "browser",
        ok: true,
        level: "warn",
        message: `headless shell=${status.headless_shell ? "yes" : "no"} chromium=${status.chromium ? "yes" : "no"}（${status.path}）`,
      };
    }
    return {
      name: "browser",
      ok: false,
      level: "warn",
      code: "BROWSER_NOT_INSTALLED",
      message: `未找到浏览器缓存：${status.path}`,
    };
  } catch (error) {
    return {
      name: "browser",
      ok: false,
      level: "warn",
      code: "BROWSER_NOT_INSTALLED",
      message: errorMessage(error),
    };
  }
}

async function checkServices(
  root: string,
  deps: DoctorDeps,
  flaresolverrEnabled = true,
): Promise<DoctorCheck> {
  try {
    const status = await (deps.probe ?? probeStack)(root);
    const names = SERVICE_NAMES.filter(
      (name) => name !== "flaresolverr" || flaresolverrEnabled,
    );
    const down = names.filter((name) => !status.services[name].up);
    if (down.length === 0) {
      return {
        name: "services",
        ok: true,
        level: "warn",
        message:
          names.length === SERVICE_NAMES.length
            ? "三个服务均可达"
            : "gateway / searxng 可达（FlareSolverr 已关闭）",
      };
    }
    return {
      name: "services",
      ok: false,
      level: "warn",
      code: "SERVICE_DOWN",
      message: `不可达：${down.join("、")}`,
    };
  } catch (error) {
    return {
      name: "services",
      ok: false,
      level: "warn",
      code: "SERVICE_DOWN",
      message: errorMessage(error),
    };
  }
}

/** 依次执行全部检查；任何单项异常都折算为对应检查失败，不影响其余项。 */
export async function runDoctor(root: string, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(checkInstallation(root, deps));
  checks.push(checkNode(deps));
  checks.push(checkPython(root, deps));

  const config = checkConfig(root, deps);
  checks.push(config.check);
  checks.push(checkToken(config.tokenConfigured));

  checks.push(checkLaunch(root));
  checks.push(await checkPort(root, deps));
  checks.push(checkManager(root, deps));
  checks.push(checkBrowser(deps));
  checks.push(await checkServices(root, deps, config.flaresolverrEnabled));
  return checks;
}

export function failedErrors(checks: DoctorCheck[]): DoctorCheck[] {
  return checks.filter((check) => !check.ok && check.level === "error");
}

export function renderChecks(checks: DoctorCheck[]): string {
  const header = ["CHECK", "LEVEL", "STATUS", "DETAIL"];
  const rows = checks.map((check) => [
    check.name,
    check.level,
    check.ok ? "ok" : "fail",
    check.message ?? (check.ok ? "" : check.code ?? ""),
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();

  const failed = checks.filter((check) => !check.ok);
  const summary = failed.length === 0
    ? "全部检查通过。"
    : `${failed.length} 项需要注意（error ${failed.filter((item) => item.level === "error").length}，warn ${failed.filter((item) => item.level === "warn").length}）。`;

  return [formatRow(header), ...rows.map((row) => formatRow(row)), "", summary].join("\n");
}

let testDeps: DoctorDeps | null = null;

/** 测试注入：避免 doctor 命令触碰真实端口、服务管理器与浏览器缓存。 */
export function setDoctorDepsForTests(deps: DoctorDeps | null): void {
  testDeps = deps;
}

export const run: CommandFn = async ({ root }) => {
  const checks = await runDoctor(root, testDeps ?? {});
  const failed = failedErrors(checks);
  const human = renderChecks(checks);

  return {
    data: { checks },
    human,
    // 报告型命令：始终有 data.checks；error 级失败用退出码表达。
    exitCode: failed.length > 0 ? EXIT.FAIL : EXIT.OK,
  };
};
