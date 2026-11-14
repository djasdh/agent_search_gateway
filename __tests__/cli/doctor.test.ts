import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reporter } from "../../src/cli/output.js";
import type { CliError } from "../../src/cli/errors.js";
import {
  run as doctorRun,
  runDoctor,
  setDoctorDepsForTests,
  type DoctorCheck,
  type DoctorDeps,
} from "../../src/cli/commands/doctor.js";

const tempDirs: string[] = [];
const jsonReporter = new Reporter({ json: true, jsonl: false });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-doctor-"));
  tempDirs.push(dir);
  return dir;
}

function makeRoot(options: { current?: boolean } = {}): string {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "data", "runtime"), { recursive: true });
  if (options.current !== false) {
    const release = path.join(root, "release");
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "current.json"),
      `${JSON.stringify({ dir: release, version: "0.3.0" })}\n`,
      "utf8",
    );
  }
  return root;
}

function writeFiles(root: string): void {
  fs.writeFileSync(path.join(root, "gateway.yaml"), "gateway:\n  port: 3000\n", "utf8");
  fs.writeFileSync(path.join(root, "secrets.yaml"), "gateway:\n  token: \"test-token\"\n", "utf8");
  fs.writeFileSync(
    path.join(root, "data", "runtime", "launch.json"),
    `${JSON.stringify({ services: [] })}\n`,
    "utf8",
  );
}

function goodDeps(): DoctorDeps {
  return {
    nodeVersion: "20.18.1",
    env: {},
    python: () => ({ ok: true, version: "3.12.1" }),
    probePort: async () => ({ port: 3000, state: "free" }),
    detect: () => ({ mode: "pid", registered: true, active: true }),
    browser: () => ({ headless_shell: true, chromium: true, path: "/tmp/ms-playwright" }),
    probe: async () => ({
      services: {
        gateway: { up: true },
        searxng: { up: true },
        flaresolverr: { up: true },
      },
      supervisor: { managed: false, mode: "pid", active: true },
    }),
  };
}

function byName(checks: DoctorCheck[], name: string): DoctorCheck {
  const check = checks.find((item) => item.name === name);
  if (!check) throw new Error(`缺少检查项 ${name}`);
  return check;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setDoctorDepsForTests(goodDeps());
});

afterEach(() => {
  setDoctorDepsForTests(null);
});

describe("doctor 检查项", () => {
  it("健康安装根：10 项全部通过", async () => {
    const root = makeRoot();
    writeFiles(root);

    const result = await doctorRun({ root, reporter: jsonReporter, rest: [] });
    const checks = (result.data as { checks: DoctorCheck[] }).checks;

    expect(checks.map((check) => check.name)).toEqual([
      "installation",
      "node",
      "python",
      "config",
      "gateway_token",
      "launch",
      "port",
      "service_manager",
      "browser",
      "services",
    ]);
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.human).toContain("全部检查通过");
  });

  it("flaresolverr 已关闭时不因它不可达而告警", async () => {
    const root = makeRoot();
    writeFiles(root);
    fs.writeFileSync(
      path.join(root, "gateway.yaml"),
      "gateway:\n  port: 3000\nflaresolverr:\n  enabled: false\n",
      "utf8",
    );

    const checks = await runDoctor(root, {
      ...goodDeps(),
      probe: async () => ({
        services: {
          gateway: { up: true },
          searxng: { up: true },
          flaresolverr: { up: false, error: "ECONNREFUSED" },
        },
        supervisor: { managed: false, mode: "pid", active: true },
      }),
    });

    expect(byName(checks, "services")).toMatchObject({
      ok: true,
      message: expect.stringContaining("FlareSolverr 已关闭"),
    });
  });

  it("未安装（缺 data/current）→ installation NOT_INSTALLED，退出码 1", async () => {
    const root = makeRoot({ current: false });

    const result = await doctorRun({ root, reporter: jsonReporter, rest: [] });
    expect(result.exitCode).toBe(1);
    const checks = (result.data as { checks: DoctorCheck[] }).checks;
    expect(byName(checks, "installation")).toMatchObject({
      ok: false,
      level: "error",
      code: "NOT_INSTALLED",
    });
    expect(byName(checks, "config")).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(byName(checks, "launch")).toMatchObject({ ok: false, code: "SCHEMA_MISMATCH" });
  });

  it("Node 过低 → NODE_TOO_OLD（error）", async () => {
    const root = makeRoot();
    writeFiles(root);

    const checks = await runDoctor(root, { ...goodDeps(), nodeVersion: "20.0.0" });
    expect(byName(checks, "node")).toMatchObject({
      ok: false,
      level: "error",
      code: "NODE_TOO_OLD",
    });
  });

  it("只有 warn 失败时不影响退出码", async () => {
    const root = makeRoot();
    writeFiles(root);
    fs.rmSync(path.join(root, "secrets.yaml"));

    const result = await doctorRun({
      root,
      reporter: jsonReporter,
      rest: [],
    });
    const checks = (result.data as { checks: DoctorCheck[] }).checks;

    expect(byName(checks, "gateway_token")).toMatchObject({
      ok: false,
      level: "warn",
      code: "MISSING_SECRET",
    });
  });

  it("warn 项：浏览器缺失、服务不可达、未注册服务管理器", async () => {
    const root = makeRoot();
    writeFiles(root);

    const checks = await runDoctor(root, {
      ...goodDeps(),
      browser: () => ({ headless_shell: false, chromium: false, path: "/tmp/ms-playwright" }),
      detect: () => ({ mode: "pid", registered: false, active: false }),
      probe: async () => ({
        services: {
          gateway: { up: false, error: "ECONNREFUSED" },
          searxng: { up: false, error: "ECONNREFUSED" },
          flaresolverr: { up: false, error: "ECONNREFUSED" },
        },
        supervisor: { managed: false, mode: "pid", active: false },
      }),
      probePort: async () => ({ port: 3000, state: "other" }),
    });

    expect(byName(checks, "browser")).toMatchObject({
      ok: false,
      level: "warn",
      code: "BROWSER_NOT_INSTALLED",
    });
    expect(byName(checks, "service_manager")).toMatchObject({
      ok: false,
      level: "warn",
      code: "SERVICE_NOT_REGISTERED",
    });
    expect(byName(checks, "port")).toMatchObject({ ok: false, code: "PORT_IN_USE" });
    expect(byName(checks, "services")).toMatchObject({
      ok: false,
      level: "warn",
      code: "SERVICE_DOWN",
    });
  });

  it("launch.json 含 searxng 服务时检查 Python（warn）", async () => {
    const root = makeRoot();
    writeFiles(root);
    fs.writeFileSync(
      path.join(root, "data", "runtime", "launch.json"),
      `${JSON.stringify({
        services: [
          {
            name: "searxng",
            command: ["python", "granian"],
            cwd: root,
            health: "http://127.0.0.1:8888/healthz",
          },
        ],
      })}\n`,
      "utf8",
    );

    const checks = await runDoctor(root, {
      ...goodDeps(),
      python: () => ({ ok: false, message: "Python 3.8 低于 3.10" }),
    });

    expect(byName(checks, "python")).toMatchObject({
      ok: false,
      level: "warn",
      code: "PYTHON_MISSING",
    });
    // python 只是 warn，不会让 doctor 失败。
    expect(checks.filter((check) => !check.ok && check.level === "error")).toEqual([]);
  });
});

describe("doctor 命令层", () => {
  it("有 error 级失败时返回 data.checks 并以退出码 1 结束", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = makeRoot({ current: false });

    const result = await doctorRun({ root, reporter: jsonReporter, rest: [] });
    expect(result.exitCode).toBe(1);
    expect(result.ok).not.toBe(false);
    expect(result.data).toMatchObject({ checks: expect.any(Array) });
    spy.mockRestore();
  });
});
