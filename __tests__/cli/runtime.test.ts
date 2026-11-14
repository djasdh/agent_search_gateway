import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Reporter } from "../../src/cli/output.js";
import type { CliError } from "../../src/cli/errors.js";
import { probeStack, startStack, stopStack, waitGateway } from "../../src/cli/runtime/stack.js";
import { loadLaunchConfig, parseLaunchConfig } from "../../src/cli/runtime/launch.js";
import { run as statusRun } from "../../src/cli/commands/status.js";
import { run as startRun } from "../../src/cli/commands/start.js";
import { run as stopRun } from "../../src/cli/commands/stop.js";

const mocks = vi.hoisted(() => ({
  detection: {
    mode: "pid" as "pid" | "systemd" | "launchd" | "schtasks" | "none",
    registered: false,
    active: false,
  },
  startService: vi.fn(),
  stopService: vi.fn(),
  restartService: vi.fn(),
}));

vi.mock("../../src/cli/platform/index.js", () => ({
  createPlatformEnv: () => ({
    runner: () => ({ ok: true, status: 0, stdout: "", stderr: "" }),
    platform: "linux",
    home: "/tmp",
    uid: "1000",
  }),
  detectManager: () => ({ ...mocks.detection }),
  startService: mocks.startService,
  stopService: mocks.stopService,
  restartService: mocks.restartService,
}));

const reporter = new Reporter({ json: true, jsonl: false });
const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function listen(handler: RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function writeConfig(root: string, values: { gatewayPort: number; searxngUrl: string; flaresolverrUrl: string }): void {
  fs.writeFileSync(
    path.join(root, "gateway.yaml"),
    [
      "gateway:",
      `  port: ${values.gatewayPort}`,
      "searxng:",
      `  url: ${values.searxngUrl}`,
      "flaresolverr:",
      `  url: ${values.flaresolverrUrl}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeLaunch(root: string, payload: unknown): string {
  const dir = path.join(root, "data", "runtime");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "launch.json");
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function expectSchemaError(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeTruthy();
  expect((caught as CliError).code).toBe("SCHEMA_MISMATCH");
  expect((caught as CliError).exitCode).toBe(4);
}

let gatewayUpPort = 0;
let gatewayDownPort = 0;
let searxngPort = 0;
let flaresolverrPort = 0;

const GATEWAY_BODY = {
  gateway: { version: "0.3.0", uptimeSec: 123 },
  searxng: { status: "up", latencyMs: 3 },
  flaresolverr: { status: "down", latencyMs: 0, error: "ECONNREFUSED" },
};

beforeAll(async () => {
  gatewayUpPort = await listen((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(GATEWAY_BODY));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  gatewayDownPort = await listen((_req, res) => {
    res.writeHead(503);
    res.end("unavailable");
  });
  searxngPort = await listen((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  flaresolverrPort = await listen((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
});

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.detection.mode = "pid";
  mocks.detection.registered = false;
  mocks.detection.active = false;
  vi.clearAllMocks();
});

describe("status 探测", () => {
  it("gateway 不可访问时并发直探 searxng 与 flaresolverr", async () => {
    const root = tempRoot();
    writeConfig(root, {
      gatewayPort: gatewayDownPort,
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
    });

    const status = await probeStack(root);

    expect(status.services.gateway.up).toBe(false);
    expect(status.services.gateway.error).toBeTruthy();
    expect(status.services.searxng.up).toBe(true);
    expect(status.services.flaresolverr.up).toBe(true);
    expect(status.supervisor).toEqual({ managed: false, mode: "pid", active: false });
  });

  it("gateway 在线时采用 /health 返回的后端结果与版本信息", async () => {
    const root = tempRoot();
    writeConfig(root, {
      gatewayPort: gatewayUpPort,
      // 直探会失败；如果仍采用直探结果，说明 /health 没被使用。
      searxngUrl: `http://127.0.0.1:${gatewayDownPort}`,
      flaresolverrUrl: `http://127.0.0.1:${gatewayDownPort}`,
    });

    const status = await probeStack(root);

    expect(status.services.gateway.up).toBe(true);
    expect(status.services.gateway.version).toBe("0.3.0");
    expect(status.services.gateway.uptime_s).toBe(123);
    expect(status.services.searxng).toEqual({ up: true, latency_ms: 3 });
    expect(status.services.flaresolverr.up).toBe(false);
    expect(status.services.flaresolverr.error).toBe("ECONNREFUSED");
  });

  it("status 命令返回完整字段，服务全 down 也不影响命令成功", async () => {
    const root = tempRoot();
    writeConfig(root, {
      gatewayPort: gatewayDownPort,
      searxngUrl: `http://127.0.0.1:${gatewayDownPort}`,
      flaresolverrUrl: `http://127.0.0.1:${gatewayDownPort}`,
    });

    const result = await statusRun({ root, reporter, rest: [] });
    const data = result.data as Awaited<ReturnType<typeof probeStack>>;

    expect(Object.keys(data.services).sort()).toEqual(["flaresolverr", "gateway", "searxng"]);
    expect(data.services.gateway.up).toBe(false);
    expect(data.services.searxng.up).toBe(false);
    expect(data.services.flaresolverr.up).toBe(false);
    expect(data.supervisor.mode).toBe("pid");
    expect(result.human).toContain("SERVICE");
    expect(result.human).toContain("gateway");
  });
});

describe("启停幂等", () => {
  it("start 时 gateway 已健康 → already_running，且不调用服务管理器", async () => {
    const root = tempRoot();
    writeConfig(root, {
      gatewayPort: gatewayUpPort,
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
    });

    const result = await startStack(root, reporter);

    expect(result.state).toBe("already_running");
    expect(result.supervisor.mode).toBe("pid");
    expect(mocks.startService).not.toHaveBeenCalled();
  });

  it("stop 时没有 pid 文件 → already_stopped", async () => {
    const root = tempRoot();
    writeConfig(root, {
      gatewayPort: gatewayDownPort,
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
    });

    const result = await stopStack(root, reporter);
    expect(result.state).toBe("already_stopped");
    expect(mocks.stopService).not.toHaveBeenCalled();
  });

  it("start / stop 命令的 data.state 与幂等结果一致", async () => {
    const upRoot = tempRoot();
    writeConfig(upRoot, {
      gatewayPort: gatewayUpPort,
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
    });
    const started = await startRun({ root: upRoot, reporter, rest: [] });
    expect((started.data as { state: string }).state).toBe("already_running");

    const downRoot = tempRoot();
    writeConfig(downRoot, {
      gatewayPort: gatewayDownPort,
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
    });
    const stopped = await stopRun({ root: downRoot, reporter, rest: [] });
    expect((stopped.data as { state: string }).state).toBe("already_stopped");
  });

  it("stop 会向 pid 文件里的进程发 SIGTERM 并等待退出", async () => {
    const root = tempRoot();
    writeConfig(root, {
      gatewayPort: gatewayDownPort,
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
    });

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.pid).toBeTruthy();

    const runtimeDir = path.join(root, "data", "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "supervisor.pid"), `${child.pid}\n`, "utf8");

    const result = await stopStack(root, reporter);
    await exited;

    expect(result.state).toBe("stopped");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("waitGateway 超时抛 HEALTH_TIMEOUT", async () => {
    const root = tempRoot();
    writeConfig(root, {
      gatewayPort: gatewayDownPort,
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
    });

    await expect(waitGateway(root, 50)).rejects.toMatchObject({
      code: "HEALTH_TIMEOUT",
      exitCode: 1,
    });
  });
});

describe("launch.json 校验", () => {
  it("合法配置按 services 顺序返回，并解析 cwd", () => {
    const root = tempRoot();
    const file = writeLaunch(root, {
      services: [
        {
          name: "gateway",
          command: ["node", "dist/index.js"],
          env: { FOO: 1 },
          health: "http://127.0.0.1:3000/health",
        },
        { name: "worker", command: ["node", "worker.js"], cwd: "sub", health: null },
      ],
    });
    fs.mkdirSync(path.join(root, "sub"));

    const config = loadLaunchConfig(root, file);
    expect(config.services.map((service) => service.name)).toEqual(["gateway", "worker"]);
    expect(config.services[0]!.env).toEqual({ FOO: "1" });
    expect(config.services[1]!.cwd).toBe(path.join(root, "sub"));
    expect(config.services[1]!.health).toBeNull();
  });

  it("缺少 services 时按空数组处理并给出 warning", () => {
    const config = parseLaunchConfig("{}", "/tmp/root");
    expect(config.services).toEqual([]);
    expect(config.warnings.length).toBe(1);
  });

  it("非法 JSON 报 SCHEMA_MISMATCH", () => {
    const root = tempRoot();
    writeLaunch(root, {});
    const file = path.join(root, "data", "runtime", "launch.json");
    fs.writeFileSync(file, "{not json", "utf8");
    expectSchemaError(() => loadLaunchConfig(root));
  });

  it("重复服务名、空 command、不存在的 cwd、非法 health 都报 SCHEMA_MISMATCH", () => {
    const root = tempRoot();

    expectSchemaError(() =>
      parseLaunchConfig(
        JSON.stringify({
          services: [
            { name: "a", command: ["node"], health: null },
            { name: "a", command: ["node"], health: null },
          ],
        }),
        root,
      ),
    );

    expectSchemaError(() =>
      parseLaunchConfig(JSON.stringify({ services: [{ name: "a", command: [] }] }), root),
    );

    expectSchemaError(() =>
      parseLaunchConfig(
        JSON.stringify({ services: [{ name: "a", command: ["node"], cwd: "missing" }] }),
        root,
      ),
    );

    expectSchemaError(() =>
      parseLaunchConfig(
        JSON.stringify({ services: [{ name: "a", command: ["node"], health: "ftp://x" }] }),
        root,
      ),
    );
  });
});
