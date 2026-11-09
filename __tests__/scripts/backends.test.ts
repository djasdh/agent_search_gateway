import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CLI = join(ROOT, "scripts", "backends", "cli.mjs");
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "backends-test-"));
  dirs.push(d);
  return d;
}

function run(args: string[], configPath: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GATEWAY_CONFIG_FILE: configPath },
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("后端安装 CLI 契约", () => {
  it("无参数时打印用法并以 1 退出", () => {
    const config = join(tmp(), "gateway.yaml");
    const r = run([], config);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("用法");
  });

  it("--help 以 0 退出", () => {
    const config = join(tmp(), "gateway.yaml");
    const r = run(["--help"], config);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("install");
    expect(r.stdout).toContain("uninstall");
  });

  it("未知后端以 1 退出", () => {
    const config = join(tmp(), "gateway.yaml");
    const r = run(["nope"], config);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("未知后端");
  });

  it("未知子命令以 1 退出", () => {
    const config = join(tmp(), "gateway.yaml");
    const r = run(["bili", "nope"], config);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("未知子命令");
  });

  it("四个后端的 status 都能正常输出且不创建配置", () => {
    const config = join(tmp(), "gateway.yaml");
    for (const name of ["bili", "ytdlp", "opencli", "article"]) {
      const r = run([name, "status"], config);
      expect(r.status, `${name} status`).toBe(0);
      expect(r.stdout).toContain(`[${name}]`);
      expect(r.stdout).toContain("安装状态");
    }
    expect(existsSync(config)).toBe(false);
  });
});
