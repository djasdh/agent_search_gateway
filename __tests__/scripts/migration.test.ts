import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts", "migrations", "0.3.x.mjs");
const WEIBO = "djasdh/agent-search-gateway-plugin-weibo";
const CNKI = "djasdh/agent-search-gateway-plugin-cnki";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "asg-migration-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 伪造 bin/asg.mjs。它只认识迁移脚本用到的四条命令：
 * extensions install / extensions setup / restart / status --json。
 * 所有调用追加到 ASG_FAKE_LOG，仓库到插件 id 的映射来自 ASG_FAKE_REPOS。
 */
const FAKE_BIN = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const logFile = process.env.ASG_FAKE_LOG || path.join(root, "calls.jsonl");
const repos = JSON.parse(process.env.ASG_FAKE_REPOS || "{}");
const backends = JSON.parse(process.env.ASG_FAKE_BACKENDS || "{}");

function record(entry) {
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n");
}

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function parseTarget(value) {
  const at = value.lastIndexOf("@");
  if (at <= 0) fail("bad install target: " + value);
  return { repo: value.slice(0, at), version: value.slice(at + 1) };
}

const command = args[0];

if (command === "extensions" && args[1] === "install") {
  const { repo, version } = parseTarget(args[2] || "");
  const id = repos[repo];
  if (!id) fail("unknown repo: " + repo, 3);
  record({ cmd: "install", repo, id, version });
  if (process.env.ASG_FAKE_FAIL_INSTALL === version) {
    fail("injected install failure for " + version, 1);
  }
  const dir = path.join(root, "data", "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: id,
    version,
    api_version: 1,
    provides: ["search"],
    entry: "index.mjs",
    backends: backends[id] || [],
  };
  fs.writeFileSync(path.join(dir, "asg-plugin.json"), JSON.stringify(manifest, null, 2));
  process.exit(0);
}

if (command === "extensions" && args[1] === "setup") {
  const id = args[2] || "";
  record({ cmd: "setup", id });
  if (process.env.ASG_FAKE_FAIL_SETUP === id) fail("injected setup failure: " + id, 1);
  const dir = path.join(root, "data", "backends", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "marker"), "keep");
  process.exit(0);
}

if (command === "restart" && process.env.ASG_FAKE_HANG_RESTART === "1") {
  record({ cmd: "restart" });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (command === "restart") {
  record({ cmd: "restart" });
  if (process.env.ASG_FAKE_FAIL_RESTART === "1") fail("injected restart failure", 1);
  process.exit(0);
}

if (command === "status") {
  record({ cmd: "status" });
  const up = process.env.ASG_FAKE_STATUS_DOWN === "1" ? false : true;
  console.log(
    JSON.stringify({
      services: {
        gateway: { up },
        searxng: { up },
        flaresolverr: { up },
      },
      supervisor: { mode: "none", active: false, managed: false },
    }),
  );
  process.exit(0);
}

fail("unknown command: " + args.join(" "), 2);
`;

function makeRoot(): string {
  const root = tmp();
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "asg.mjs"), FAKE_BIN);
  writeFileSync(join(root, "gateway.yaml"), "gateway:\n  host: 127.0.0.1\n  port: 3999\n");
  return root;
}

function installPlugin(
  root: string,
  plugin: { id: string; version: string; backends?: string[]; apiVersion?: 1 | 2 },
): void {
  const dir = join(root, "data", "extensions", plugin.id);
  mkdirSync(dir, { recursive: true });
  const apiVersion = plugin.apiVersion ?? 1;
  writeFileSync(
    join(dir, apiVersion === 2 ? "asg-extension.json" : "asg-plugin.json"),
    JSON.stringify(
      {
        id: plugin.id,
        name: plugin.id,
        version: plugin.version,
        api_version: apiVersion,
        provides: ["search"],
        entry: "index.mjs",
        backends: plugin.backends ?? [],
      },
      null,
      2,
    ),
  );
}

function readManifest(root: string, id: string): { version?: string } {
  const dir = join(root, "data", "extensions", id);
  const file = existsSync(join(dir, "asg-extension.json"))
    ? "asg-extension.json"
    : "asg-plugin.json";
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

function writeChecklist(
  plugins: Array<{ id: string; repo: string; version: string }>,
): string {
  const file = join(tmp(), "checklist.json");
  writeFileSync(file, JSON.stringify({ schema: 1, plugins }, null, 2));
  return file;
}

interface RunOptions {
  manifest?: string;
  env?: Record<string, string>;
}

function run(root: string, args: string[], options: RunOptions = {}) {
  const env: Record<string, string> = {
    ...process.env,
    ASG_FAKE_LOG: join(root, "calls.jsonl"),
    ASG_FAKE_REPOS: JSON.stringify({ [WEIBO]: "weibo", [CNKI]: "cnki" }),
    ...options.env,
  };
  if (options.manifest) env.ASG_MIGRATION_MANIFEST = options.manifest;
  else delete env.ASG_MIGRATION_MANIFEST;

  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
}

function calls(root: string): Array<Record<string, unknown>> {
  const file = join(root, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readState(root: string): any {
  return JSON.parse(
    readFileSync(join(root, "data", "migrations", "0.3.x", "state.json"), "utf8"),
  );
}

function writeState(root: string, state: unknown): void {
  const dir = join(root, "data", "migrations", "0.3.x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

function lastJsonLine(stdout: string): any {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!);
}

function backupDirs(root: string): string[] {
  const dir = join(root, "data", "migrations", "0.3.x");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("backup-"));
}

describe("0.3.x 迁移脚本：参数与 dry-run", () => {
  it("--help 以 0 退出并列出参数", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--phase");
    expect(result.stdout).toContain("--rollback");
  });

  it("dry-run 只输出计划，不写 state、不备份、不执行命令", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const result = run(root, ["--dry-run"], { manifest });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("0.1.0 -> 0.2.0");
    expect(existsSync(join(root, "data", "migrations", "0.3.x", "state.json"))).toBe(false);
    expect(backupDirs(root)).toEqual([]);
    expect(calls(root)).toEqual([]);
    expect(readManifest(root, "weibo").version).toBe("0.1.0");
  });

  it("--jsonl 的每一行都是 JSON，最后一行是 result", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const result = run(root, ["--dry-run", "--jsonl"], { manifest });
    expect(result.status, result.stderr).toBe(0);

    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.type).toBe("result");
    expect(last.ok).toBe(true);
    expect(last.dry_run).toBe(true);
  });
});

describe("0.3.x 迁移脚本：阶段顺序", () => {
  it("all 按 preflight -> plugins -> backends -> restart 执行", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0", backends: ["article"] });
    installPlugin(root, { id: "mystery", version: "1.0.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const result = run(root, [], {
      manifest,
      env: { ASG_FAKE_BACKENDS: JSON.stringify({ weibo: ["article"] }) },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(calls(root).map((call) => call.cmd)).toEqual([
      "install",
      "setup",
      "restart",
      "status",
    ]);
    expect(calls(root)[0]).toMatchObject({ id: "weibo", version: "0.2.0" });
    expect(readManifest(root, "weibo").version).toBe("0.2.0");
    expect(readManifest(root, "mystery").version).toBe("1.0.0");

    expect(result.stderr + result.stdout).toContain("第三方插件 mystery");

    const state = readState(root);
    expect(state.phases.preflight.status).toBe("done");
    expect(state.phases.plugins.status).toBe("done");
    expect(state.phases.backends.status).toBe("done");
    expect(state.phases.config.status).toBe("done");
    expect(state.phases.restart.status).toBe("done");
    expect(state.plugins.weibo).toMatchObject({
      from: "0.1.0",
      to: "0.2.0",
      status: "installed",
    });
    expect(state.backends.weibo.status).toBe("done");
    expect(backupDirs(root)).toHaveLength(1);
    expect(
      existsSync(join(root, "data", "migrations", "0.3.x", backupDirs(root)[0]!, "gateway.yaml")),
    ).toBe(true);
  });

  it("config 阶段迁移平台配置与密钥到 extensions", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "gateway.yaml"),
      [
        "gateway:",
        "  host: 127.0.0.1",
        "  port: 3999",
        "bilibili:",
        "  enabled: true",
        "  http:",
        "    base_url: http://127.0.0.1:8010",
        "weibo:",
        "  enabled: true",
        "search:",
        "  weibo:",
        "    limit: 7",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "secrets.yaml"),
      ["bilibili:", "  http:", "    token: secret-token", ""].join("\n"),
    );
    installPlugin(root, { id: "weibo", version: "0.2.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const result = run(root, ["--phase", "config"], { manifest });
    expect(result.status, result.stderr).toBe(0);

    const gateway = parse(readFileSync(join(root, "gateway.yaml"), "utf8"));
    expect(gateway.bilibili).toBeUndefined();
    expect(gateway.weibo).toBeUndefined();
    expect(gateway.search.weibo).toBeUndefined();
    expect(gateway.extensions.weibo.config).toEqual({
      enabled: true,
      search: { limit: 7 },
    });
    expect(gateway.extensions.bilibili.config).toEqual({
      enabled: true,
      http: { base_url: "http://127.0.0.1:8010" },
    });

    const secrets = parse(readFileSync(join(root, "secrets.yaml"), "utf8"));
    expect(secrets.bilibili).toBeUndefined();
    expect(secrets.extensions.bilibili.token).toBe("secret-token");
    expect(readState(root).phases.config.status).toBe("done");
    expect(calls(root)).toEqual([]);
  });

  it("识别 asg-extension.json 的 V2 manifest", () => {
    const root = makeRoot();
    installPlugin(root, {
      id: "weibo",
      version: "0.2.0",
      apiVersion: 2,
      backends: ["article"],
    });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const result = run(root, ["--phase", "backends"], {
      manifest,
      env: { ASG_FAKE_BACKENDS: JSON.stringify({ weibo: ["article"] }) },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls(root).some((call) => call.cmd === "setup" && call.id === "weibo")).toBe(true);
  });
});

describe("0.3.x 迁移脚本：配置写回权限", () => {
  function modeOf(file: string): number {
    return statSync(file).mode & 0o777;
  }

  function writeConfigs(root: string): void {
    writeFileSync(
      join(root, "gateway.yaml"),
      [
        "gateway:",
        "  host: 127.0.0.1",
        "  port: 3999",
        "bilibili:",
        "  enabled: true",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "secrets.yaml"),
      ["bilibili:", "  http:", "    token: secret-token", ""].join("\n"),
    );
  }

  it("config 阶段写回 secrets.yaml 后仍是 0600，gateway.yaml 保留自定义 mode", () => {
    const root = makeRoot();
    writeConfigs(root);
    chmodSync(join(root, "gateway.yaml"), 0o640);
    chmodSync(join(root, "secrets.yaml"), 0o600);
    installPlugin(root, { id: "weibo", version: "0.2.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const result = run(root, ["--phase", "config"], { manifest });
    expect(result.status, result.stderr).toBe(0);

    expect(modeOf(join(root, "gateway.yaml"))).toBe(0o640);
    expect(modeOf(join(root, "secrets.yaml"))).toBe(0o600);

    const gateway = parse(readFileSync(join(root, "gateway.yaml"), "utf8"));
    expect(gateway.bilibili).toBeUndefined();
    expect(gateway.extensions.bilibili.config.enabled).toBe(true);
    const secrets = parse(readFileSync(join(root, "secrets.yaml"), "utf8"));
    expect(secrets.extensions.bilibili.token).toBe("secret-token");
  });

  it("secrets.yaml 原为 0644 时 config 阶段收紧到 0600", () => {
    const root = makeRoot();
    writeConfigs(root);
    chmodSync(join(root, "secrets.yaml"), 0o644);
    installPlugin(root, { id: "weibo", version: "0.2.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const result = run(root, ["--phase", "config"], { manifest });
    expect(result.status, result.stderr).toBe(0);

    expect(modeOf(join(root, "secrets.yaml"))).toBe(0o600);
    const secrets = parse(readFileSync(join(root, "secrets.yaml"), "utf8"));
    expect(secrets.extensions.bilibili.token).toBe("secret-token");
  });
});

describe("0.3.x 迁移脚本：续跑与回滚", () => {
  it("--resume 从第一个未完成阶段继续，且不重复 preflight 备份", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0", backends: ["article"] });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);
    const env = { ASG_FAKE_BACKENDS: JSON.stringify({ weibo: ["article"] }) };

    const first = run(root, ["--phase", "preflight"], { manifest, env });
    expect(first.status, first.stderr).toBe(0);
    expect(readState(root).phases.preflight.status).toBe("done");
    expect(readState(root).phases.plugins.status).toBe("pending");
    expect(calls(root)).toEqual([]);
    expect(backupDirs(root)).toHaveLength(1);

    const second = run(root, ["--resume"], { manifest, env });
    expect(second.status, second.stderr).toBe(0);
    expect(calls(root).map((call) => call.cmd)).toEqual([
      "install",
      "setup",
      "restart",
      "status",
    ]);
    expect(backupDirs(root)).toHaveLength(1);
    expect(readState(root).phases.plugins.status).toBe("done");
    expect(readState(root).phases.restart.status).toBe("done");
  });

  it("--rollback 恢复配置备份并重装旧插件版本，保留后端目录", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0", backends: ["article"] });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);
    const env = { ASG_FAKE_BACKENDS: JSON.stringify({ weibo: ["article"] }) };
    const originalConfig = readFileSync(join(root, "gateway.yaml"), "utf8");

    const migrate = run(root, [], { manifest, env });
    expect(migrate.status, migrate.stderr).toBe(0);
    expect(readManifest(root, "weibo").version).toBe("0.2.0");

    writeFileSync(join(root, "gateway.yaml"), `${originalConfig}extra: true\n`);
    expect(existsSync(join(root, "data", "backends", "weibo", "marker"))).toBe(true);

    const rollback = run(root, ["--rollback"], { manifest, env });
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(readManifest(root, "weibo").version).toBe("0.1.0");
    expect(readFileSync(join(root, "gateway.yaml"), "utf8")).toBe(originalConfig);
    expect(existsSync(join(root, "data", "backends", "weibo", "marker"))).toBe(true);

    const installs = calls(root).filter((call) => call.cmd === "install");
    expect(installs.at(-1)).toMatchObject({ id: "weibo", version: "0.1.0" });
    expect(readState(root).rollback.status).toBe("done");
  });

  it("--rollback-on-failure 在升级失败后自动恢复配置", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);
    const originalConfig = readFileSync(join(root, "gateway.yaml"), "utf8");

    const result = run(root, ["--rollback-on-failure"], {
      manifest,
      env: { ASG_FAKE_FAIL_INSTALL: "0.2.0" },
    });

    expect(result.status).toBe(1);
    const state = readState(root);
    expect(state.phases.plugins.status).toBe("failed");
    expect(state.rollback.status).toBe("done");
    expect(readManifest(root, "weibo").version).toBe("0.1.0");
    expect(readFileSync(join(root, "gateway.yaml"), "utf8")).toBe(originalConfig);
  });
});

describe("0.3.x 迁移脚本：清单与目标选择", () => {
  it("缺清单时报错且不执行任何命令", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });

    const result = run(root, [], {
      manifest: join(root, "missing-checklist.json"),
    });

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("未找到迁移清单");
    expect(calls(root)).toEqual([]);
    expect(readState(root).phases.preflight.status).toBe("failed");
  });

  it("清单里的插件未安装时跳过并告警，且不执行 restart", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.2.0" });
    const manifest = writeChecklist([{ id: "cnki", repo: CNKI, version: "0.2.0" }]);

    const result = run(root, [], { manifest });

    expect(result.status, result.stderr).toBe(0);
    expect(calls(root)).toEqual([]);
    expect(result.stderr + result.stdout).toContain("cnki 未安装");
    expect(result.stderr + result.stdout).toContain("均未安装");
    const state = readState(root);
    expect(state.plugins.cnki.status).toBe("skipped");
    expect(state.phases.restart.status).toBe("skipped");
    expect(state.phases.restart.note).toContain("没有可处理目标");
  });

  it("空清单不重启网关，restart 记为 skipped", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    const manifest = writeChecklist([]);

    const result = run(root, [], { manifest });

    expect(result.status, result.stderr).toBe(0);
    expect(calls(root)).toEqual([]);
    expect(result.stderr + result.stdout).toContain("清单为空");
    const state = readState(root);
    expect(state.phases.restart.status).toBe("skipped");
    expect(state.phases.restart.note).toContain("没有可处理目标");
  });

  it("--plugin 覆盖清单版本，重新计算 from/to", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const result = run(root, ["--plugin", `weibo=${WEIBO}@0.2.1`], { manifest });

    expect(result.status, result.stderr).toBe(0);
    expect(readManifest(root, "weibo").version).toBe("0.2.1");
    expect(calls(root).find((call) => call.cmd === "install")).toMatchObject({
      version: "0.2.1",
    });
    expect(readState(root).plugins.weibo).toMatchObject({
      from: "0.1.0",
      to: "0.2.1",
      status: "installed",
    });
  });

  it("--continue-on-error 在单插件失败后继续处理其余插件", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    installPlugin(root, { id: "cnki", version: "0.1.0" });
    const manifest = writeChecklist([
      { id: "weibo", repo: WEIBO, version: "0.2.0" },
      { id: "cnki", repo: CNKI, version: "0.2.0" },
    ]);

    const result = run(root, ["--phase", "plugins", "--continue-on-error"], {
      manifest,
      env: { ASG_FAKE_FAIL_INSTALL: "0.2.0", ASG_FAKE_BACKENDS: "{}" },
    });

    expect(result.status).toBe(1);
    const installs = calls(root).filter((call) => call.cmd === "install");
    expect(installs.map((call) => call.id)).toEqual(["cnki", "weibo"]);
    const state = readState(root);
    expect(state.plugins.weibo.status).toBe("failed");
    expect(state.plugins.cnki.status).toBe("failed");
    expect(state.phases.plugins.status).toBe("failed");
  });
});

describe("0.3.x 迁移脚本：健壮性", () => {
  it("--jsonl 下顶层失败的最后一行仍是 result", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });

    const result = run(root, ["--jsonl"], {
      manifest: join(root, "missing-checklist.json"),
    });

    expect(result.status).toBe(1);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const last = lastJsonLine(result.stdout);
    expect(last.type).toBe("result");
    expect(last.ok).toBe(false);
    expect(last.error).toContain("未找到迁移清单");
  });

  it("--jsonl 下 main 的顶层异常也输出 result", () => {
    const root = makeRoot();
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);
    const preflight = run(root, ["--phase", "preflight"], { manifest });
    expect(preflight.status, preflight.stderr).toBe(0);

    // 让回滚阶段的扩展扫描直接抛异常，验证 main 的兜底 catch 也输出 result。
    rmSync(join(root, "data", "extensions"), { recursive: true, force: true });
    writeFileSync(join(root, "data", "extensions"), "not a directory");

    const result = run(root, ["--rollback", "--jsonl"], { manifest });
    expect(result.status).toBe(1);
    const last = lastJsonLine(result.stdout);
    expect(last.type).toBe("result");
    expect(last.ok).toBe(false);
    expect(last.error).toContain("无法读取扩展目录");
  });

  it("runAsg 超时会终止子进程并报迁移错误", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.2.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const started = Date.now();
    const result = run(root, ["--phase", "restart", "--jsonl"], {
      manifest,
      env: { ASG_FAKE_HANG_RESTART: "1", ASG_MIGRATION_COMMAND_TIMEOUT_MS: "300" },
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe(1);
    expect(elapsed).toBeLessThan(10_000);
    const last = lastJsonLine(result.stdout);
    expect(last.type).toBe("result");
    expect(last.ok).toBe(false);
    expect(last.error).toContain("超时");
    const state = readState(root);
    expect(state.phases.restart.status).toBe("failed");
    expect(state.phases.restart.error).toContain("超时");
  });

  it("state 的 schema / migration / root 不匹配时报错", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const preflight = run(root, ["--phase", "preflight"], { manifest });
    expect(preflight.status, preflight.stderr).toBe(0);

    const badSchema = { ...readState(root), schema: 2 };
    writeState(root, badSchema);
    const schemaRun = run(root, ["--resume"], { manifest });
    expect(schemaRun.status).toBe(1);
    expect(schemaRun.stderr + schemaRun.stdout).toContain("schema 不匹配");

    const badMigration = { ...badSchema, schema: 1, migration: "0.2.x" };
    writeState(root, badMigration);
    const migrationRun = run(root, ["--resume"], { manifest });
    expect(migrationRun.status).toBe(1);
    expect(migrationRun.stderr + migrationRun.stdout).toContain("migration 不匹配");

    const badRoot = {
      ...badMigration,
      migration: "0.3.x",
      root: join(tmp(), "another-install-root"),
    };
    writeState(root, badRoot);
    const rootRun = run(root, ["--resume"], { manifest });
    expect(rootRun.status).toBe(1);
    expect(rootRun.stderr + rootRun.stdout).toContain("root 与当前安装根不一致");
  });

  it("backends 已记录 done 时 --resume 不再重复 setup", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0", backends: ["article"] });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);
    const env = { ASG_FAKE_BACKENDS: JSON.stringify({ weibo: ["article"] }) };

    const first = run(root, ["--phase", "backends"], { manifest, env });
    expect(first.status, first.stderr).toBe(0);
    expect(calls(root).filter((call) => call.cmd === "setup")).toHaveLength(1);

    const second = run(root, ["--phase", "backends", "--resume"], { manifest, env });
    expect(second.status, second.stderr).toBe(0);
    expect(calls(root).filter((call) => call.cmd === "setup")).toHaveLength(1);
    expect(second.stderr + second.stdout).toContain("跳过 setup");

    const state = readState(root);
    expect(state.backends.weibo.status).toBe("done");
    expect(state.backends.weibo.skipped).toBe(true);
  });

  it("没有配置备份时回滚不报“回滚完成”，只说明回滚插件", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);
    const originalConfig = readFileSync(join(root, "gateway.yaml"), "utf8");

    const migrate = run(root, ["--phase", "plugins"], { manifest });
    expect(migrate.status, migrate.stderr).toBe(0);
    writeFileSync(join(root, "gateway.yaml"), `${originalConfig}extra: true\n`);

    const rollback = run(root, ["--rollback"], { manifest });
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(rollback.stdout).toContain("没有配置备份");
    expect(rollback.stdout).not.toContain("回滚完成");
    expect(readManifest(root, "weibo").version).toBe("0.1.0");
    // 没有备份就不应改动配置。
    expect(readFileSync(join(root, "gateway.yaml"), "utf8")).toBe(`${originalConfig}extra: true\n`);

    const state = readState(root);
    expect(state.rollback.status).toBe("done-with-warning");
    expect(state.rollback.warning).toContain("没有配置备份");
  });

  it("重复 preflight 复用原备份，不创建新备份目录", () => {
    const root = makeRoot();
    installPlugin(root, { id: "weibo", version: "0.1.0" });
    const manifest = writeChecklist([{ id: "weibo", repo: WEIBO, version: "0.2.0" }]);

    const first = run(root, ["--phase", "preflight"], { manifest });
    expect(first.status, first.stderr).toBe(0);
    const firstBackup = readState(root).backup.dir;

    const second = run(root, ["--phase", "preflight"], { manifest });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("复用已有配置备份");
    expect(readState(root).backup.dir).toBe(firstBackup);
    expect(backupDirs(root)).toHaveLength(1);
  });
});
