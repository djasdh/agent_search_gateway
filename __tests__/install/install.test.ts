// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { prepareConfig, readGatewayPort } from "../../scripts/install/config.mjs";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import {
  launchFile,
  readLaunchJson,
  writeLaunchJson,
} from "../../scripts/install/launch.mjs";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import {
  parseArgs,
  platformTag,
  refreshLaunchWithGateway,
} from "../../scripts/install/cli.mjs";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { installSearxng } from "../../scripts/install/deps/searxng.mjs";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { buildHeaders, formatDownloadFailure, proxyEnvName, sha256File, verifySha256 } from "../../scripts/install/http.mjs";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import {
  disableBundledReadline,
  findXvfb,
  isReadlineConflict,
  prependPath,
  summarizeSmokeFailure,
  xvfbCandidateDirs,
} from "../../scripts/install/flaresolverr.mjs";
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
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseLaunchConfig } from "../../src/cli/runtime/launch.js";

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

  it("--searxng-mode 只接受 auto | native | external", () => {
    for (const mode of ["auto", "native", "external"]) {
      expect(parseArgs(["--searxng-mode", mode]).searxngMode).toBe(mode);
    }
    expect(() => parseArgs(["--searxng-mode", "docker"])).toThrow(/auto \| native \| external/);
  });
});

describe("searxng 安装资源", () => {
  const pins = {
    searxng: {
      commit: "abc",
      archive: "https://example.com/searxng.zip",
      sha256: "0".repeat(64),
    },
  };

  it("settings 模板与 quota 种子已迁到 searxng-ext", () => {
    const template = join(ROOT, "searxng-ext/settings.template.yml");
    const quota = join(ROOT, "searxng-ext/quota.config.json");
    expect(existsSync(template)).toBe(true);
    expect(existsSync(quota)).toBe(true);
    expect(parse(readFileSync(template, "utf8")).use_default_settings).toBe(true);
    expect(Object.keys(parse(readFileSync(quota, "utf8")).engines).length).toBeGreaterThan(0);

    const source = readFileSync(join(ROOT, "scripts/install/deps/searxng.mjs"), "utf8");
    expect(source).toContain("'searxng-ext', 'settings.template.yml'");
    expect(source).toContain("'searxng-ext', 'quota.config.json'");
    expect(source).not.toMatch(/installDocker|dockerCompose|dockerUsable/);
  });

  it("拒绝 docker 安装模式", async () => {
    await expect(
      installSearxng({
        root: tmp(),
        platform: "linux",
        pins,
        options: { mode: "docker" },
        logger: () => {},
      }),
    ).rejects.toThrow(/auto \| native \| external/);
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

    // 升级/重装不再覆盖首次安装写入的值。
    const configAfter = parse(readFileSync(second.configPath, "utf8"));
    expect(configAfter.gateway.port).toBe(3100);
    expect(configAfter.searxng.url).toBe("http://127.0.0.1:18888");
    expect(configAfter.flaresolverr.url).toBe("http://127.0.0.1:18192");
    expect(configAfter.flaresolverr.enabled).toBe(false);
  });

  it("已有 gateway.yaml 时保留自定义值，只补缺失键", async () => {
    const currentDir = tmp();
    copyFileSync(join(ROOT, "gateway.yaml.example"), join(currentDir, "gateway.yaml.example"));
    copyFileSync(join(ROOT, "secrets.yaml.example"), join(currentDir, "secrets.yaml.example"));

    const installRoot = tmp();
    writeFileSync(
      join(installRoot, "gateway.yaml"),
      [
        "gateway:",
        "  port: 4321",
        "searxng:",
        "  url: http://127.0.0.1:19999",
        "flaresolverr:",
        "  enabled: false",
        "",
      ].join("\n"),
    );

    const result = await prepareConfig({
      installRoot,
      currentDir,
      port: 3100,
      searxngUrl: "http://127.0.0.1:18888",
      flaresolverrUrl: "http://127.0.0.1:18192",
      flaresolverrEnabled: true,
    });

    const config = parse(readFileSync(result.configPath, "utf8"));
    expect(config.gateway.port).toBe(4321);
    expect(config.searxng.url).toBe("http://127.0.0.1:19999");
    expect(config.flaresolverr.enabled).toBe(false);
    // 缺失的键用 CLI 参数补齐。
    expect(config.flaresolverr.url).toBe("http://127.0.0.1:18192");
  });

  it("读取 gateway.port：合法值生效，非法/缺失回退", async () => {
    const root = tmp();
    const fallback = 3456;

    await expect(readGatewayPort(root, fallback)).resolves.toBe(fallback);

    writeFileSync(join(root, "gateway.yaml"), "gateway:\n  port: 4321\n");
    await expect(readGatewayPort(root, fallback)).resolves.toBe(4321);

    writeFileSync(join(root, "gateway.yaml"), 'gateway:\n  port: "4321"\n');
    await expect(readGatewayPort(root, fallback)).resolves.toBe(4321);

    writeFileSync(join(root, "gateway.yaml"), "gateway:\n  port: abc\n");
    await expect(readGatewayPort(root, fallback)).resolves.toBe(fallback);

    writeFileSync(join(root, "gateway.yaml"), "gateway:\n  port: 70000\n");
    await expect(readGatewayPort(root, fallback)).resolves.toBe(fallback);

    writeFileSync(join(root, "gateway.yaml"), "gateway:\n  host: 127.0.0.1\n");
    await expect(readGatewayPort(root, fallback)).resolves.toBe(fallback);
  });
});

describe("启动清单", () => {
  it("--launch-only 重写旧清单后 flaresolverr 仍按可选服务解析", async () => {
    const installRoot = tmp();
    await writeLaunchJson({
      installRoot,
      services: [
        {
          name: "flaresolverr",
          command: ["flaresolverr"],
          cwd: installRoot,
          env: {},
          health: "http://127.0.0.1:8192/",
        },
      ],
    });
    await refreshLaunchWithGateway({
      installRoot,
      gatewayLaunch: {
        name: "gateway",
        command: ["node", "dist/index.js"],
        cwd: installRoot,
        env: {},
        health: "http://127.0.0.1:3000/health",
      },
    });

    const written = await readLaunchJson({ installRoot });
    expect(written.services[0].required).toBeUndefined();
    const parsed = parseLaunchConfig(
      readFileSync(launchFile(installRoot), "utf8"),
      installRoot,
    );
    expect(parsed.services[0]!.required).toBe(false);
    expect(parsed.services[1]!.required).toBe(true);
  });

  it("--launch-only 使用 gateway.yaml 中的端口（忽略 --port 默认值）", () => {
    const installRoot = tmp();
    writeFileSync(join(installRoot, "gateway.yaml"), "gateway:\n  port: 4321\n");

    const result = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/install/cli.mjs"), "--install-root", installRoot, "--launch-only"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);

    const written = JSON.parse(
      readFileSync(join(installRoot, "data", "runtime", "launch.json"), "utf8"),
    );
    const gateway = written.services.find(
      (service: { name: string }) => service.name === "gateway",
    );
    expect(gateway.health).toBe("http://127.0.0.1:4321/health");
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

  it("GitHub token 只发给 api.github.com，不跟随资产地址", () => {
    const api = buildHeaders("https://api.github.com/repos/a/b/releases", "tkn");
    expect(api.Authorization).toBe("Bearer tkn");
    expect(api.Accept).toBeUndefined();

    const asset = buildHeaders("https://github.com/a/b/releases/download/v1/x.mjs", "tkn", {
      Authorization: "Bearer tkn",
    });
    expect(asset.Authorization).toBeUndefined();
  });
});

describe("下载失败原因汇总", () => {
  const url = "https://api.github.com/repos/a/b/releases/tags/v1";

  it("保留全部真实原因，403 优先提示 GITHUB_TOKEN", () => {
    const text = formatDownloadFailure(url, [
      "HTTP 403",
      "curl: curl: (22) The requested URL returned error: 403",
      "wget: spawn wget ENOENT",
    ]);
    expect(text).toContain("下载失败");
    expect(text).toContain("- HTTP 403");
    expect(text).toContain("403");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).not.toContain("HTTPS_PROXY=");
  });

  it("过滤命令不存在，避免掩盖真实原因", () => {
    const text = formatDownloadFailure(url, [
      "fetch: 网络错误",
      "wget: spawn wget ENOENT",
    ]);
    expect(text).toContain("- fetch: 网络错误");
    expect(text).not.toContain("wget");
    expect(text).toContain("HTTPS_PROXY");
  });

  it("全部是命令缺失时给出明确结论", () => {
    const text = formatDownloadFailure(url, [
      "curl: spawn curl ENOENT",
      "wget: spawn wget ENOENT",
    ]);
    expect(text).toContain("没有可用的下载方式");
    expect(text).not.toContain("GITHUB_TOKEN");
  });

  it("检测到代理变量时优先提示检查代理", () => {
    const text = formatDownloadFailure(url, ["fetch: fetch failed"], { proxy: "HTTPS_PROXY" });
    expect(text).toContain("已检测到代理变量 HTTPS_PROXY");
    expect(text).not.toContain("export GITHUB_TOKEN");
  });
});

describe("FlareSolverr 自带 readline 冲突", () => {
  it("识别 /bin/sh 的 symbol lookup error", () => {
    expect(
      isReadlineConflict(
        "/bin/sh: symbol lookup error: /bin/sh: undefined symbol: rl_trim_arg_from_keyseq",
      ),
    ).toBe(true);
    expect(isReadlineConflict("启动后 30 秒内未通过健康检查")).toBe(false);
  });

  it("只禁用 libreadline，保留其它自带库，且幂等", async () => {
    const dir = tmp();
    const internal = join(dir, "_internal");
    mkdirSync(internal, { recursive: true });
    writeFileSync(join(internal, "libreadline.so.8"), "rl");
    writeFileSync(join(internal, "libreadline.so.8.3"), "rl");
    writeFileSync(join(internal, "libtinfo.so.6"), "ti");

    const moved = await disableBundledReadline(dir);
    expect(moved).toHaveLength(2);
    expect(existsSync(join(internal, "libreadline.so.8.disabled"))).toBe(true);
    expect(existsSync(join(internal, "libreadline.so.8.3.disabled"))).toBe(true);
    expect(existsSync(join(internal, "libtinfo.so.6"))).toBe(true);

    await expect(disableBundledReadline(dir)).resolves.toEqual([]);
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

  it("install.ps1 无 BOM、不用 param 块、不用 exit（兼容 irm | iex）", () => {
    const buffer = readFileSync(join(ROOT, "scripts/install.ps1"));
    expect(buffer[0]).not.toBe(0xef);
    const text = buffer.toString("utf8");
    expect(text).not.toMatch(/^\s*param\s*\(/m);
    expect(text).not.toMatch(/^\s*exit\b/m);
  });

  it("shell 变量不紧跟非 ASCII 字符（防中文括号吞进变量名）", () => {
    // bash 3.2（macOS 自带）把全角括号算进变量名，`$VAR（` 会变成 `VAR（` → unbound variable。
    const files = ["scripts/install.sh", "scripts/install-weibo-override.sh", "scripts/bench.sh"];
    const pattern = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      text.split(/\r?\n/).forEach((line, index) => {
        expect(pattern.test(line), `${file}:${index + 1} ${line}`).toBe(false);
      });
    }
  });
});

describe("FlareSolverr 的 Xvfb 依赖", () => {
  it("在 PATH 之外的常见目录（conda）也能找到 Xvfb", () => {
    const home = tmp();
    const bin = join(home, "miniconda3", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "Xvfb"), "");

    const candidates = xvfbCandidateDirs({ env: { PATH: "/nonexistent" }, home });
    expect(candidates).toContain(bin);
    // 只喂候选目录，避免宿主 /usr/bin/Xvfb 存在时抢先命中，测试依赖机器环境。
    expect(findXvfb({ dirs: [bin], platform: "linux" })).toEqual({
      binary: join(bin, "Xvfb"),
      dir: bin,
    });
  });

  it("找不到返回 null；Windows 直接跳过", () => {
    const home = tmp();
    const dirs = [join(home, "empty")];
    expect(findXvfb({ dirs, platform: "linux" })).toBeNull();
    expect(findXvfb({ dirs: [home], platform: "win32" })).toBeNull();
  });

  it("候选目录 PATH 优先、去重", () => {
    const home = tmp();
    const dirs = xvfbCandidateDirs({
      env: { PATH: ["/a", "/b"].join(path.delimiter) },
      home,
    });
    expect(dirs.slice(0, 2)).toEqual(["/a", "/b"]);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs).toContain(join(home, "miniconda3", "bin"));
    expect(dirs).toContain("/usr/bin");
  });

  it("prependPath 置顶且不重复", () => {
    expect(prependPath("/x", ["/a", "/x", "/b"].join(path.delimiter))).toBe(
      ["/x", "/a", "/b"].join(path.delimiter),
    );
  });

  it("自检失败上报真实异常（Xvfb），而不是 PYI 最后一行", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "utils.py", line 346, in start_xvfb_display',
      "FileNotFoundError: Could not find Xvfb. Please install it and try again",
      "Exception: Error getting browser User-Agent. Could not find Xvfb.",
      "[PYI-1:ERROR] Failed to execute script 'flaresolverr' due to unhandled exception!",
    ].join("\n");

    const detail = summarizeSmokeFailure(stderr, 60_000);
    expect(detail).toContain("Could not find Xvfb");
    expect(detail).toContain("apt install xvfb");
    expect(detail).not.toContain("Failed to execute script");
  });

  it("无 stderr 时说明是健康检查超时", () => {
    expect(summarizeSmokeFailure("", 90_000)).toContain("90 秒");
  });
});
