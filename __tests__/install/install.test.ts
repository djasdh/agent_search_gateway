// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { prepareConfig } from "../../scripts/install/config.mjs";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { parseArgs, platformTag } from "../../scripts/install/cli.mjs";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { proxyEnvName, sha256File, verifySha256 } from "../../scripts/install/http.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = process.cwd();
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "install-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("安装器参数与平台", () => {
  it("映射五个发布平台", () => {
    expect(platformTag("linux", "x64")).toBe("linux-x64");
    expect(platformTag("linux", "arm64")).toBe("linux-arm64");
    expect(platformTag("darwin", "x64")).toBe("darwin-x64");
    expect(platformTag("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformTag("win32", "x64")).toBe("win32-x64");
  });

  it("解析常用参数", () => {
    const opts = parseArgs([
      "--install-root", "/tmp/asg",
      "--port", "3100",
      "--no-browser",
      "--deps-only",
    ]);
    expect(opts.installRoot).toBe("/tmp/asg");
    expect(opts.port).toBe(3100);
    expect(opts.noBrowser).toBe(true);
    expect(opts.depsOnly).toBe(true);
  });

  it("拒绝未知参数", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/未知参数/);
  });
});

describe("配置生成", () => {
  it("写入端口、依赖 URL、随机 token，并保留已有 token", async () => {
    const currentDir = tmp();
    copyFileSync(join(ROOT, "gateway.yaml.example"), join(currentDir, "gateway.yaml.example"));
    copyFileSync(join(ROOT, "secrets.yaml.example"), join(currentDir, "secrets.yaml.example"));

    const installRoot = tmp();
    const first = await prepareConfig({
      installRoot,
      currentDir,
      port: 3100,
      searxngUrl: "http://127.0.0.1:18888",
      flaresolverrUrl: "http://127.0.0.1:18192",
      flaresolverrEnabled: false,
    });

    const config = parse(readFileSync(first.configPath, "utf8"));
    expect(config.gateway.port).toBe(3100);
    expect(config.searxng.url).toBe("http://127.0.0.1:18888");
    expect(config.flaresolverr.url).toBe("http://127.0.0.1:18192");
    expect(config.flaresolverr.enabled).toBe(false);

    const secrets = parse(readFileSync(first.secretsPath, "utf8"));
    expect(secrets.gateway.token).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(first.secretsPath).mode & 0o777).toBe(0o600);

    const second = await prepareConfig({
      installRoot,
      currentDir,
      port: 3000,
      searxngUrl: "http://127.0.0.1:8888",
      flaresolverrUrl: "http://127.0.0.1:8192",
      flaresolverrEnabled: true,
    });
    expect(second.token).toBe(first.token);
  });
});

describe("下载校验", () => {
  it("sha256File 与 verifySha256", async () => {
    const d = tmp();
    const file = join(d, "a.tar.gz");
    writeFileSync(file, "hello");
    const hash = createHash("sha256").update("hello").digest("hex");
    await expect(sha256File(file)).resolves.toBe(hash);
    await expect(verifySha256(file, hash)).resolves.toBeUndefined();
  });

  it("校验失败删除文件", async () => {
    const d = tmp();
    const file = join(d, "a.tar.gz");
    writeFileSync(file, "tampered");
    await expect(verifySha256(file, "0".repeat(64))).rejects.toThrow(/SHA256 校验失败/);
    expect(existsSync(file)).toBe(false);
  });

  it("代理变量优先级", () => {
    const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
    const backup = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      expect(proxyEnvName()).toBe(null);
      process.env.ALL_PROXY = "http://127.0.0.1:7897";
      expect(proxyEnvName()).toBe("ALL_PROXY");
      process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
      expect(proxyEnvName()).toBe("HTTPS_PROXY");
    } finally {
      for (const k of keys) {
        if (backup[k] === undefined) delete process.env[k];
        else process.env[k] = backup[k];
      }
    }
  });
});

describe("runtime.json 生成", () => {
  it("按平台生成 assets 与 sha256", () => {
    const artifacts = tmp();
    writeFileSync(join(artifacts, "agent-search-gateway-1.0.0-linux-x64.tar.gz"), "linux");
    writeFileSync(join(artifacts, "agent-search-gateway-1.0.0-win32-x64.zip"), "windows");
    writeFileSync(join(artifacts, "SHA256SUMS"), "ignored");
    const pins = join(artifacts, "pins.json");
    writeFileSync(pins, JSON.stringify({ searxng: { commit: "abc" }, playwright: "1.0.0" }));
    const output = join(artifacts, "runtime.json");

    const result = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/install/make-runtime.mjs"), artifacts, pins, "1.0.0", output],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const runtime = JSON.parse(readFileSync(output, "utf8"));
    expect(runtime.version).toBe("1.0.0");
    expect(runtime.assets["linux-x64"].name).toBe("agent-search-gateway-1.0.0-linux-x64.tar.gz");
    expect(runtime.assets["linux-x64"].sha256).toBe(
      createHash("sha256").update("linux").digest("hex"),
    );
    expect(runtime.assets["win32-x64"].name).toBe("agent-search-gateway-1.0.0-win32-x64.zip");
    expect(runtime.deps.searxng.commit).toBe("abc");
  });
});

describe("引导脚本语法", () => {
  it("install.sh 通过 bash -n", () => {
    const result = spawnSync("bash", ["-n", join(ROOT, "scripts/install.sh")], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});
