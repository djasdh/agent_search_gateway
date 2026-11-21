// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { writeCurrentState } from "../../scripts/install/state.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const VERSION = "9.9.9";
const PLATFORM = (
  {
    linux: { x64: "linux-x64", arm64: "linux-arm64" },
    darwin: { x64: "darwin-x64", arm64: "darwin-arm64" },
  } as Record<string, Record<string, string>>
)[process.platform]?.[process.arch];

const dirs: string[] = [];

function tmp(prefix = "install-sh-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("writeCurrentState", () => {
  it("相对路径按安装根解析后写成绝对路径", async () => {
    const root = tmp();
    const payload = await writeCurrentState({
      root,
      dir: "data/releases/1.0.0-linux-x64",
      version: "1.0.0",
    });

    expect(isAbsolute(payload.dir)).toBe(true);
    expect(payload.dir).toBe(join(root, "data/releases/1.0.0-linux-x64"));

    const written = readJson(join(root, "data/current.json"));
    expect(written.dir).toBe(payload.dir);
    expect(isAbsolute(written.dir as string)).toBe(true);
    expect(written.version).toBe("1.0.0");
  });

  it("目录含引号或反斜杠时仍写出合法 JSON", async () => {
    const root = tmp();
    const dir = join(root, "releases", 'we"ird\\dir');
    const payload = await writeCurrentState({ root, dir, version: "1.0.0" });

    const text = readFileSync(join(root, "data/current.json"), "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
    expect(readJson(join(root, "data/current.json")).dir).toBe(dir);
    expect(payload.dir).toBe(dir);
  });

  it("写入 previous 信息，相对路径同样按安装根解析", async () => {
    const root = tmp();
    const payload = await writeCurrentState({
      root,
      dir: join(root, "data/releases/2.0.0-linux-x64"),
      version: "2.0.0",
      previousDir: "data/releases/1.0.0-linux-x64",
      previousVersion: "1.0.0",
    });

    expect(payload.previousDir).toBe(join(root, "data/releases/1.0.0-linux-x64"));
    expect(payload.previousVersion).toBe("1.0.0");

    const written = readJson(join(root, "data/current.json"));
    expect(written.previousDir).toBe(payload.previousDir);
    expect(written.previousVersion).toBe("1.0.0");
  });

  it("没有 previous 时写 null", async () => {
    const root = tmp();
    await writeCurrentState({ root, dir: join(root, "release"), version: "1.0.0" });
    const written = readJson(join(root, "data/current.json"));
    expect(written.previousDir).toBeNull();
    expect(written.previousVersion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// install.sh 行为测试：用假的 curl 提供 runtime.json / 安装包，
// 用包里的假 cli.mjs 控制成功或失败，验证“先 cli、后切换”。
// ---------------------------------------------------------------------------

const FAKE_CLI = `import fs from 'node:fs';
import path from 'node:path';
import { switchCurrent } from './state.mjs';

const argv = process.argv.slice(2);
const rootArg = argv[argv.indexOf('--install-root') + 1];
const root = path.resolve(rootArg || process.cwd());
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'cli-ran'), 'yes\\n');

const exitCode = Number(process.env.FAKE_CLI_EXIT || '0');
if (exitCode !== 0) process.exit(exitCode);

const version = process.env.FAKE_VERSION || '${VERSION}';
const platform = process.env.FAKE_PLATFORM || 'linux-x64';
const target = path.join(root, 'data', 'releases', version + '-' + platform);

let old = null;
try {
  old = JSON.parse(fs.readFileSync(path.join(root, 'data', 'current.json'), 'utf8'));
} catch {}

let previousVersion = process.env.FAKE_PREVIOUS_VERSION || '';
let previousDir = process.env.FAKE_PREVIOUS_DIR || '';
if (!previousVersion && old?.version) {
  if (old.version !== version) {
    previousVersion = old.version;
    previousDir = old.dir || '';
  } else {
    previousVersion = old.previousVersion || '';
    previousDir = old.previousDir || '';
  }
}

const installed = {
  schemaVersion: 1,
  repo: 'test/repo',
  platform,
  current: {
    version,
    dir: target,
    installedAt: new Date().toISOString(),
  },
  previous: previousVersion
    ? { version: previousVersion, dir: previousDir, installedAt: null }
    : null,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(root, 'data', 'installed.json'),
  JSON.stringify(installed, null, 2) + '\\n',
);

if (argv.includes('--switch-current')) {
  await switchCurrent({
    root,
    dir: target,
    version,
    previousDir: previousDir || null,
    previousVersion: previousVersion || null,
  });
}
`;

const CURL_STUB = `#!/usr/bin/env bash
set -e
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -C) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */runtime.json) cp "$FAKE_FIXTURE_DIR/runtime.json" "$out" ;;
  *.tar.gz) cp "$FAKE_FIXTURE_DIR/package.tar.gz" "$out" ;;
  *) echo "unexpected url: $url" >&2; exit 22 ;;
esac
`;

interface Fixture {
  dir: string;
  binDir: string;
}

/** 构造一个最小可安装包 + 假 curl，返回 fixture 路径。 */
function buildFixture(): Fixture {
  const fixture = tmp("install-sh-fixture-");
  const binDir = join(fixture, "bin");
  const staging = join(fixture, "staging");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(staging, "bin"), { recursive: true });
  mkdirSync(join(staging, "dist"), { recursive: true });
  mkdirSync(join(staging, "scripts", "install"), { recursive: true });

  writeFileSync(join(staging, "version.json"), JSON.stringify({ version: VERSION }));
  writeFileSync(join(staging, "dist", "index.js"), "// fake dist\n");
  writeFileSync(join(staging, "bin", "asg.mjs"), "#!/usr/bin/env node\n// new launcher\n");
  writeFileSync(join(staging, "scripts", "install", "cli.mjs"), FAKE_CLI);
  copyFileSync(
    join(ROOT, "scripts", "install", "state.mjs"),
    join(staging, "scripts", "install", "state.mjs"),
  );

  const archive = join(fixture, "package.tar.gz");
  const tar = spawnSync(
    "tar",
    ["-czf", archive, "-C", staging, "version.json", "dist", "bin", "scripts"],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) throw new Error(`tar 失败: ${tar.stderr}`);

  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(
    join(fixture, "runtime.json"),
    JSON.stringify(
      {
        version: VERSION,
        assets: { [PLATFORM as string]: { name: "package.tar.gz", sha256 } },
      },
      null,
      2,
    ),
  );

  const curl = join(binDir, "curl");
  writeFileSync(curl, CURL_STUB);
  chmodSync(curl, 0o755);

  return { dir: fixture, binDir };
}

interface RunInstallOptions {
  root: string;
  fixture: Fixture;
  cliExit: number;
  cwd?: string;
  dirArg?: string;
  previousVersion?: string;
  previousDir?: string;
}

function runInstall(options: RunInstallOptions) {
  return spawnSync(
    "bash",
    [
      join(ROOT, "scripts", "install.sh"),
      "--dir",
      options.dirArg ?? options.root,
      "--version",
      VERSION,
    ],
    {
      cwd: options.cwd ?? ROOT,
      env: {
        ...process.env,
        PATH: `${options.fixture.binDir}:${process.env.PATH ?? ""}`,
        FAKE_FIXTURE_DIR: options.fixture.dir,
        FAKE_CLI_EXIT: String(options.cliExit),
        FAKE_VERSION: VERSION,
        FAKE_PLATFORM: PLATFORM as string,
        FAKE_PREVIOUS_VERSION: options.previousVersion ?? "",
        FAKE_PREVIOUS_DIR: options.previousDir ?? "",
      },
      encoding: "utf8",
    },
  );
}

/** 写入旧版本状态，返回旧 current.json 与 current 指向。 */
function seedOldState(
  root: string,
  options: { version: string; previousDir?: string | null; previousVersion?: string | null },
): { currentJson: string; currentLink: string; releaseDir: string } {
  const releaseDir = join(root, "data", "releases", `${options.version}-${PLATFORM}`);
  mkdirSync(releaseDir, { recursive: true });
  const currentLink = join(root, "data", "current");
  symlinkSync(`releases/${options.version}-${PLATFORM}`, currentLink);
  const currentJson = join(root, "data", "current.json");
  writeFileSync(
    currentJson,
    `${JSON.stringify(
      {
        dir: releaseDir,
        version: options.version,
        previousDir: options.previousDir ?? null,
        previousVersion: options.previousVersion ?? null,
        updatedAt: "2020-01-01T00:00:00Z",
      },
      null,
      2,
    )}\n`,
  );
  return { currentJson, currentLink, releaseDir };
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const shellTest = PLATFORM && nodeMajor >= 20 ? describe : describe.skip;

shellTest("install.sh 先 cli 后切换", () => {
  it("cli 失败时保留旧 current 与 current.json", () => {
    const root = tmp();
    const fixture = buildFixture();
    const old = seedOldState(root, { version: "0.1.0" });
    const beforeJson = readFileSync(old.currentJson, "utf8");
    const beforeLink = readlinkSync(old.currentLink);

    const result = runInstall({ root, fixture, cliExit: 1 });

    expect(result.status).not.toBe(0);
    expect(readFileSync(old.currentJson, "utf8")).toBe(beforeJson);
    expect(readlinkSync(old.currentLink)).toBe(beforeLink);
    // 新 release 目录允许保留，只是不能切换。
    expect(existsSync(join(root, "data", "releases", `${VERSION}-${PLATFORM}`))).toBe(true);
  });

  it("cli 成功后切换 current，previous 取自 installed.json", () => {
    const base = tmp();
    const root = join(base, "site");
    mkdirSync(root, { recursive: true });
    const fixture = buildFixture();
    seedOldState(root, { version: "0.1.0" });
    const previousDir = join(root, "data", "releases", `0.0.9-${PLATFORM}`);

    const result = runInstall({
      root,
      fixture,
      cliExit: 0,
      cwd: base,
      dirArg: "site",
      previousVersion: "0.0.9",
      previousDir,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(join(root, "data", "current"))).toBe(
      `releases/${VERSION}-${PLATFORM}`,
    );

    const state = readJson(join(root, "data", "current.json"));
    expect(state.dir).toBe(join(root, "data", "releases", `${VERSION}-${PLATFORM}`));
    expect(isAbsolute(state.dir as string)).toBe(true);
    expect(state.previousVersion).toBe("0.0.9");
    expect(state.previousDir).toBe(previousDir);
    expect(readFileSync(join(root, "bin", "asg.mjs"), "utf8")).toContain("new launcher");
  });

  it("installed.json 没有 previous 时回退到切换前的 current", () => {
    const root = tmp();
    const fixture = buildFixture();
    const old = seedOldState(root, { version: "0.1.0" });

    const result = runInstall({ root, fixture, cliExit: 0 });

    expect(result.status, result.stderr).toBe(0);
    const state = readJson(join(root, "data", "current.json"));
    expect(state.previousVersion).toBe("0.1.0");
    expect(state.previousDir).toBe(old.releaseDir);
  });

  it("同版本重装保留已有的 previous", () => {
    const root = tmp();
    const fixture = buildFixture();
    const oldPreviousDir = join(root, "data", "releases", `0.0.8-${PLATFORM}`);
    seedOldState(root, {
      version: VERSION,
      previousVersion: "0.0.8",
      previousDir: oldPreviousDir,
    });

    const result = runInstall({ root, fixture, cliExit: 0 });

    expect(result.status, result.stderr).toBe(0);
    const state = readJson(join(root, "data", "current.json"));
    expect(state.previousVersion).toBe("0.0.8");
    expect(state.previousDir).toBe(oldPreviousDir);
  });
});
