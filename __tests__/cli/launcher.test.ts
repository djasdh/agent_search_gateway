import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = process.cwd();
const dirs: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "asg-launcher-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FAKE_CLI = `export async function main(argv) {
  process.stdout.write(JSON.stringify(argv) + "\\n");
  return 0;
}
`;

function writeFakeRelease(root: string, withLink = false): string {
  const release = join(root, "data", "releases", "9.9.9-linux-x64");
  mkdirSync(join(release, "dist", "cli"), { recursive: true });
  writeFileSync(join(release, "dist", "cli", "asg.js"), FAKE_CLI, "utf8");
  mkdirSync(join(root, "bin"), { recursive: true });
  spawnSync("cp", [join(REPO, "bin", "asg.mjs"), join(root, "bin", "asg.mjs")]);
  writeFileSync(
    join(root, "data", "current.json"),
    `${JSON.stringify({ dir: release, version: "9.9.9" })}\n`,
    "utf8",
  );
  if (withLink) spawnSync("ln", ["-s", release, join(root, "data", "current")]);
  return join(root, "bin", "asg.mjs");
}

function runLauncher(launcher: string, args: string[]) {
  return spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8" });
}

describe("bin/asg.mjs 稳定入口", () => {
  it("从 current.json 解析版本目录并注入 --root", () => {
    const root = tmpRoot();
    const launcher = writeFakeRelease(root);
    const result = runLauncher(launcher, ["status", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(["--root", root, "status", "--json"]);
  });

  it("优先使用 data/current 符号链接", () => {
    const root = tmpRoot();
    const launcher = writeFakeRelease(root, true);

    const result = runLauncher(launcher, ["logs", "-f"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(["--root", root, "logs", "-f"]);
  });

  it("找不到入口时以非 0 退出", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "bin"), { recursive: true });
    spawnSync("cp", [join(REPO, "bin", "asg.mjs"), join(root, "bin", "asg.mjs")]);

    const result = runLauncher(join(root, "bin", "asg.mjs"), ["status"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未找到 CLI 入口");
  });
});
