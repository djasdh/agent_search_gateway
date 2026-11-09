// @ts-expect-error 纯 JS 运维脚本没有类型声明，测试通过 vitest 直接加载
import * as su from "../../scripts/self-update/cli.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "self-update-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("平台与资产映射", () => {
  it("覆盖五个发布平台", () => {
    expect(su.platformTag("linux", "x64")).toBe("linux-x64");
    expect(su.platformTag("linux", "arm64")).toBe("linux-arm64");
    expect(su.platformTag("darwin", "x64")).toBe("darwin-x64");
    expect(su.platformTag("darwin", "arm64")).toBe("darwin-arm64");
    expect(su.platformTag("win32", "x64")).toBe("win32-x64");
  });

  it("不支持的平台给出明确错误", () => {
    expect(() => su.platformTag("freebsd", "x64")).toThrow(/不支持的平台/);
  });

  it("资产名按平台选择扩展名", () => {
    expect(su.buildAssetName("1.2.3", "linux-x64")).toBe(
      "agent-search-gateway-1.2.3-linux-x64.tar.gz",
    );
    expect(su.buildAssetName("1.2.3", "win32-x64")).toBe(
      "agent-search-gateway-1.2.3-win32-x64.zip",
    );
  });
});

describe("参数与版本", () => {
  it("解析常用参数", () => {
    const opts = su.parseArgs(["--version", "v1.2.3", "--check", "--no-restart", "--force"]);
    expect(opts).toMatchObject({
      version: "v1.2.3",
      check: true,
      noRestart: true,
      force: true,
      help: false,
    });
  });

  it("支持 --repo=owner/name", () => {
    expect(su.parseArgs(["--repo=djasdh/agent_search_gateway"]).repo).toBe(
      "djasdh/agent_search_gateway",
    );
  });

  it("拒绝未知参数", () => {
    expect(() => su.parseArgs(["--nope"])).toThrow(/未知参数/);
  });

  it("版本号去掉 v 前缀并拒绝路径穿越", () => {
    expect(su.normalizeVersion("v0.2.0")).toBe("0.2.0");
    expect(() => su.normalizeVersion("../1.0.0")).toThrow(/不合法/);
  });

  it("版本比较按数字段", () => {
    expect(su.versionGte("1.2.3", "1.2.3")).toBe(true);
    expect(su.versionGte("1.10.0", "1.9.9")).toBe(true);
    expect(su.versionGte("1.9.9", "1.10.0")).toBe(false);
  });
});

describe("校验和", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);

  it("解析标准与 * 标记格式", () => {
    const map = su.parseChecksums(`${a}  a.tar.gz\r\n${b} *b.zip\n# 注释\n`);
    expect(map.get("a.tar.gz")).toBe(a);
    expect(map.get("b.zip")).toBe(b);
  });

  it("sha256File 与 verifySha256 匹配", async () => {
    const d = tmp();
    const file = join(d, "pkg.tar.gz");
    writeFileSync(file, "hello");
    const hash = createHash("sha256").update("hello").digest("hex");
    await expect(su.sha256File(file)).resolves.toBe(hash);
    const sums = new Map([["pkg.tar.gz", hash]]);
    await expect(su.verifySha256(file, "pkg.tar.gz", sums)).resolves.toBe(hash);
  });

  it("校验失败删除文件", async () => {
    const d = tmp();
    const file = join(d, "pkg.tar.gz");
    writeFileSync(file, "tampered");
    const sums = new Map([["pkg.tar.gz", "c".repeat(64)]]);
    await expect(su.verifySha256(file, "pkg.tar.gz", sums)).rejects.toThrow(/SHA256 校验失败/);
    expect(existsSync(file)).toBe(false);
  });
});

describe("归档安全检查", () => {
  it("允许普通相对路径", () => {
    expect(() => su.validateArchiveEntries(["dist/index.js", "node_modules/a/index.js"])).not.toThrow();
  });

  it("拒绝绝对路径和路径穿越", () => {
    expect(() => su.validateArchiveEntries(["/etc/passwd"])).toThrow(/绝对路径/);
    expect(() => su.validateArchiveEntries(["../evil.txt"])).toThrow(/路径穿越/);
    expect(() => su.validateArchiveEntries(["a/../../evil.txt"])).toThrow(/路径穿越/);
  });

  it("isInside 判断边界", () => {
    const root = join(tmpdir(), "asg-root");
    expect(su.isInside(join(root, "a", "b"), root)).toBe(true);
    expect(su.isInside(root, root)).toBe(true);
    expect(su.isInside(join(root, "..", "escape"), root)).toBe(false);
  });

  it("findPackageRoot 兼容顶层目录与多一层包目录", async () => {
    const flat = tmp();
    mkdirSync(join(flat, "dist"));
    writeFileSync(join(flat, "dist", "index.js"), "");
    await expect(su.findPackageRoot(flat)).resolves.toBe(flat);

    const nested = tmp();
    mkdirSync(join(nested, "agent-search-gateway-1.0.0", "dist"), { recursive: true });
    writeFileSync(join(nested, "agent-search-gateway-1.0.0", "dist", "index.js"), "");
    await expect(su.findPackageRoot(nested)).resolves.toBe(
      join(nested, "agent-search-gateway-1.0.0"),
    );
  });

  it("findPackageRoot 缺少 dist/index.js 时报错", async () => {
    await expect(su.findPackageRoot(tmp())).rejects.toThrow(/未找到 dist\/index.js/);
  });
});

describe("安装状态", () => {
  it("没有 installed.json 时视为首次安装", async () => {
    const { installed } = await su.readInstalled(tmp());
    expect(installed).toBe(null);
  });

  it("写入后可以读回 current 与 previous", async () => {
    const dataDir = tmp();
    const current = { version: "1.2.3", dir: "/tmp/releases/1.2.3-linux-x64", installedAt: null };
    const previous = { version: "1.2.2", dir: "/tmp/releases/1.2.2-linux-x64", installedAt: null };
    await su.writeInstalled(dataDir, {
      repo: "djasdh/agent_search_gateway",
      platform: "linux-x64",
      current,
      previous,
    });
    const { installed } = await su.readInstalled(dataDir);
    expect(installed.current).toMatchObject({ version: "1.2.3" });
    expect(installed.previous).toMatchObject({ version: "1.2.2" });
  });
});

describe("网关端口", () => {
  it("读取 gateway.port", async () => {
    const root = tmp();
    writeFileSync(join(root, "gateway.yaml"), "gateway:\n  host: 127.0.0.1\n  port: 4321\n");
    await expect(su.readGatewayPort(root)).resolves.toBe(4321);
  });

  it("缺文件时回退 3000", async () => {
    await expect(su.readGatewayPort(tmp())).resolves.toBe(3000);
  });
});

describe("旧版本清理", () => {
  it("保留最近 N 个并保护当前版本", async () => {
    const releasesRoot = tmp();
    const names = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"];
    for (const [i, name] of names.entries()) {
      const dir = join(releasesRoot, name);
      mkdirSync(dir);
      // 用文件名区分修改时间，保证排序稳定
      writeFileSync(join(dir, `mtime-${i}`), "");
      const stamp = new Date(Date.now() - (names.length - i) * 1000);
      // eslint-disable-next-line no-sync
      const fs = await import("node:fs");
      fs.utimesSync(dir, stamp, stamp);
    }
    const protectedDir = join(releasesRoot, "1.0.0");
    const { removed } = await su.cleanupReleases({
      releasesRoot,
      protectedDirs: [protectedDir],
      keep: 3,
    });
    expect(existsSync(protectedDir)).toBe(true);
    expect(existsSync(join(releasesRoot, "1.4.0"))).toBe(true);
    expect(existsSync(join(releasesRoot, "1.3.0"))).toBe(true);
    expect(removed.length).toBe(2);
  });
});
