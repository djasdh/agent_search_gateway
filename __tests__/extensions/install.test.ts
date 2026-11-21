import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installExtension,
  listExtensions,
  loadInstalledManifest,
  parseChecksums,
  removeExtension,
  searchExtensions,
  type InstallDeps,
} from "../../src/extensions/index.js";

const MANIFEST = {
  id: "demo-fetch",
  name: "Demo Fetch",
  version: "1.2.3",
  api_version: 2,
  provides: ["fetch"],
  entry: "index.mjs",
  description: "示例插件",
};

const ENTRY_TEXT = "export const fetch = {};\n";
const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-extensions-"));
  tempDirs.push(dir);
  return dir;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sums(manifestText: string, entryName = "index.mjs", entryText = ENTRY_TEXT): string {
  return `${sha256(manifestText)}  asg-extension.json\n${sha256(entryText)}  ${entryName}\n`;
}

interface FakeDepsOptions {
  manifestText?: string;
  entryText?: string;
  sumsText?: string;
  tag?: string;
  omit?: string[];
  urls?: Record<string, string>;
  release?: unknown;
  fetchJson?: InstallDeps["fetchJson"];
  download?: InstallDeps["download"];
  sha256File?: InstallDeps["sha256File"];
  random?: () => string;
}

function makeRelease(tag: string, omit: string[] = [], urls: Record<string, string> = {}) {
  const names = ["asg-extension.json", "index.mjs", "SHA256SUMS"].filter(
    (name) => !omit.includes(name),
  );
  return {
    tag_name: tag,
    assets: names.map((name) => ({
      name,
      browser_download_url: urls[name] ?? `https://example.test/${name}`,
    })),
  };
}

function fakeDeps(options: FakeDepsOptions = {}): InstallDeps {
  const manifestText = options.manifestText ?? JSON.stringify(MANIFEST);
  const entryText = options.entryText ?? ENTRY_TEXT;
  let version = "1.2.3";
  try {
    const parsed = JSON.parse(manifestText) as { version?: unknown };
    if (typeof parsed.version === "string") version = parsed.version;
  } catch {
    // 故意构造的坏 manifest：tag 用默认值即可。
  }
  const release = options.release ?? makeRelease(options.tag ?? `v${version}`, options.omit, options.urls);
  const contents: Record<string, string> = {
    "asg-extension.json": manifestText,
    "index.mjs": entryText,
    SHA256SUMS: options.sumsText ?? sums(manifestText, "index.mjs", entryText),
  };

  return {
    fetchJson: options.fetchJson ?? vi.fn(async () => release),
    download:
      options.download ??
      vi.fn(async (url: string, dest: string) => {
        const name = url.split("/").pop()!;
        const body = contents[name];
        if (body === undefined) throw new Error(`unexpected asset: ${url}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body, "utf8");
        return dest;
      }),
    sha256File:
      options.sha256File ?? (async (file: string) => sha256(fs.readFileSync(file, "utf8"))),
    random: options.random ?? (() => "test"),
  };
}

function extensionsPath(root: string): string {
  return path.join(root, "data", "extensions");
}

function assetNames(deps: InstallDeps): string[] {
  const calls = (deps.download as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
  return calls.map(([url]) => url.split("/").pop()!);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("安装扩展", () => {
  it("从 latest 下载并按 manifest/entry/SHA256SUMS 顺序安装", async () => {
    const root = tempRoot();
    const deps = fakeDeps();

    const result = await installExtension({
      root,
      repo: "owner/asg-plugin-demo",
      deps,
    });

    expect(result).toEqual({
      id: "demo-fetch",
      version: "1.2.3",
      name: "Demo Fetch",
      provides: ["fetch"],
      backends: [],
      fetch_channels: [],
      search_engines: [],
      path: path.join(extensionsPath(root), "demo-fetch"),
    });
    expect(fs.readFileSync(path.join(result.path, "index.mjs"), "utf8")).toBe(ENTRY_TEXT);
    expect(fs.readdirSync(extensionsPath(root))).toEqual(["demo-fetch"]);

    expect(assetNames(deps)).toEqual(["asg-extension.json", "index.mjs", "SHA256SUMS"]);

    const fetchJson = deps.fetchJson as ReturnType<typeof vi.fn>;
    expect(fetchJson.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/owner/asg-plugin-demo/releases/latest",
    );

    const request = fetchJson.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(request.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(request.headers["User-Agent"]).toMatch(/^asg\//);
  });

  it("只安装 asg-extension.json 并返回 V2 字段", async () => {
    const root = tempRoot();
    const v2 = {
      ...MANIFEST,
      backends: [{ id: "demo-api", name: "Demo API", aliases: ["demo_old"] }],
      fetch_channels: [
        {
          id: "example:cli",
          name: "Example CLI",
          backends: ["demo-api"],
          aliases: ["example"],
        },
      ],
      search_engines: [{ id: "gateway.search:example", name: "Example Search" }],
    };
    const manifestText = JSON.stringify(v2);
    const sumsText = `${sha256(manifestText)}  asg-extension.json\n${sha256(ENTRY_TEXT)}  index.mjs\n`;
    const release = {
      tag_name: "v1.2.3",
      assets: [
        { name: "asg-plugin.json", browser_download_url: "https://example.test/asg-plugin.json" },
        { name: "asg-extension.json", browser_download_url: "https://example.test/asg-extension.json" },
        { name: "index.mjs", browser_download_url: "https://example.test/index.mjs" },
        { name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" },
      ],
    };
    const deps = fakeDeps({ manifestText, sumsText, release });

    const result = await installExtension({ root, repo: "owner/demo", deps });
    expect(result.backends.map((backend) => backend.id)).toEqual(["demo-api"]);
    expect(result.fetch_channels.map((channel) => channel.id)).toEqual(["example:cli"]);
    expect(result.search_engines.map((engine) => engine.id)).toEqual([
      "gateway.search:example",
    ]);
    expect(assetNames(deps)[0]).toBe("asg-extension.json");
    expect(assetNames(deps)).not.toContain("asg-plugin.json");
    expect(fs.existsSync(path.join(result.path, "asg-extension.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.path, "asg-plugin.json"))).toBe(false);
  });

  it("release 只有 asg-plugin.json 时拒绝安装", async () => {
    const deps = fakeDeps({ omit: ["asg-extension.json"] });
    await expect(
      installExtension({ root: tempRoot(), repo: "owner/demo", deps }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      message: expect.stringMatching(
        /缺少资产 asg-extension\.json（0\.4\.0 起不再接受 asg-plugin\.json）/,
      ),
    });
  });

  it("asg-extension.json 的 api_version 不是 2 时拒绝安装", async () => {
    const deps = fakeDeps({
      manifestText: JSON.stringify({ ...MANIFEST, api_version: 1 }),
    });
    await expect(
      installExtension({ root: tempRoot(), repo: "owner/demo", deps }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      message: expect.stringContaining("asg-extension.json"),
    });
  });

  it("backends 会写入安装结果与列表", async () => {
    const root = tempRoot();
    const backends = [
      {
        id: "demo-api",
        name: "Demo API",
        description: "示例后端",
        aliases: ["demo_old"],
      },
    ];
    const manifestText = JSON.stringify({ ...MANIFEST, api_version: 2, backends });
    const deps = fakeDeps({ manifestText });

    const result = await installExtension({ root, repo: "owner/demo", deps });
    expect(result.backends).toEqual(backends);

    const [listed] = listExtensions(root);
    expect(listed).toMatchObject({ id: "demo-fetch", backends });
    expect(listed!.error).toBeUndefined();

    expect(loadInstalledManifest(root, "demo-fetch").backends).toEqual(backends);
  });

  it("指定版本先试 v<version>，404 后回退到不带 v 的 tag", async () => {
    const root = tempRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith("/tags/v1.2.3")) throw new Error("HTTP 404: Not Found");
      if (url.endsWith("/tags/1.2.3")) return makeRelease("v1.2.3");
      throw new Error(`unexpected url: ${url}`);
    });
    const deps = fakeDeps({ fetchJson });

    await installExtension({ root, repo: "owner/demo", version: "v1.2.3", deps });

    expect((fetchJson.mock.calls as Array<[string]>).map(([url]) => url)).toEqual([
      "https://api.github.com/repos/owner/demo/releases/tags/v1.2.3",
      "https://api.github.com/repos/owner/demo/releases/tags/1.2.3",
    ]);
  });

  it("指定版本的 404 才回退；其它错误直接上报", async () => {
    const root = tempRoot();
    const fetchJson = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const deps = fakeDeps({ fetchJson });

    await expect(
      installExtension({ root, repo: "owner/demo", version: "1.2.3", deps }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: expect.stringContaining("network unreachable"),
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it("两个 tag 都 404 时给出“未找到 Release 版本”而不是代理提示", async () => {
    const root = tempRoot();
    const fetchJson = vi.fn(async () => {
      throw new Error("下载失败: HTTP 404\n已检测到代理变量 HTTPS_PROXY，请检查代理是否可用。");
    });
    const deps = fakeDeps({ fetchJson });

    await expect(
      installExtension({ root, repo: "owner/demo", version: "9.9.9", deps }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      message: expect.stringContaining("未找到 owner/demo 的 Release 9.9.9"),
    });
    await expect(
      installExtension({ root, repo: "owner/demo", version: "9.9.9", deps }),
    ).rejects.not.toMatchObject({ message: expect.stringContaining("代理") });
    expect(fs.existsSync(extensionsPath(root))).toBe(false);
  });

  it("latest 404 时提示仓库没有 Release", async () => {
    const root = tempRoot();
    const fetchJson = vi.fn(async () => {
      throw new Error("下载失败: HTTP 404");
    });
    const deps = fakeDeps({ fetchJson });

    await expect(installExtension({ root, repo: "owner/demo", deps })).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      message: expect.stringContaining("没有可用的 Release"),
    });
  });

  it("重复安装会原子替换旧目录，不残留 staging/trash", async () => {
    const root = tempRoot();
    const first = await installExtension({ root, repo: "owner/demo", deps: fakeDeps() });
    fs.writeFileSync(path.join(first.path, "old.txt"), "old", "utf8");

    const second = await installExtension({ root, repo: "owner/demo", deps: fakeDeps() });

    expect(second.path).toBe(first.path);
    expect(fs.existsSync(path.join(second.path, "old.txt"))).toBe(false);
    expect(fs.existsSync(path.join(second.path, "index.mjs"))).toBe(true);
    expect(fs.readdirSync(extensionsPath(root))).toEqual(["demo-fetch"]);
  });

  it("SHA256 不匹配时失败并清理 staging，保留旧安装", async () => {
    const root = tempRoot();
    const first = await installExtension({ root, repo: "owner/demo", deps: fakeDeps() });

    const deps = fakeDeps({
      entryText: "tampered\n",
      sumsText: sums(JSON.stringify(MANIFEST)),
    });
    await expect(installExtension({ root, repo: "owner/demo", deps })).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      message: expect.stringContaining("SHA256 校验失败"),
    });

    expect(fs.readFileSync(path.join(first.path, "index.mjs"), "utf8")).toBe(ENTRY_TEXT);
    expect(fs.readdirSync(extensionsPath(root))).toEqual(["demo-fetch"]);
  });

  it("缺少 SHA256SUMS / manifest / entry 资产时失败", async () => {
    for (const [omit, pattern] of [
      [["SHA256SUMS"], /缺少资产 SHA256SUMS/],
      [["asg-extension.json"], /缺少资产 asg-extension\.json/],
      [["index.mjs"], /缺少 manifest\.entry/],
    ] as const) {
      const deps = fakeDeps({ omit: [...omit] });
      await expect(
        installExtension({ root: tempRoot(), repo: "owner/demo", deps }),
      ).rejects.toMatchObject({
        code: "PLUGIN_FAILED",
        message: expect.stringMatching(pattern),
      });
    }
  });

  it("release tag 与 manifest.version 不一致时失败", async () => {
    const deps = fakeDeps({ tag: "v1.2.4" });
    await expect(
      installExtension({ root: tempRoot(), repo: "owner/demo", deps }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      message: expect.stringContaining("不一致"),
    });
  });

  it("指定版本与 manifest.version 不一致时失败", async () => {
    const deps = fakeDeps();
    await expect(
      installExtension({ root: tempRoot(), repo: "owner/demo", version: "1.2.4", deps }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      message: expect.stringContaining("不一致"),
    });
  });

  it("允许安装官方 id（内置实现已迁出）", async () => {
    const manifestText = JSON.stringify({ ...MANIFEST, id: "bilibili" });
    const deps = fakeDeps({ manifestText });
    const root = tempRoot();

    const result = await installExtension({ root, repo: "owner/demo", deps });

    expect(result.id).toBe("bilibili");
    expect(fs.readdirSync(extensionsPath(root))).toEqual(["bilibili"]);
  });

  it("非法 manifest 直接失败", async () => {
    const deps = fakeDeps({ manifestText: "{" });
    await expect(
      installExtension({ root: tempRoot(), repo: "owner/demo", deps }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      message: expect.stringContaining("manifest"),
    });
  });

  it("只接受 https 资产地址", async () => {
    const deps = fakeDeps({ urls: { "index.mjs": "http://example.test/index.mjs" } });
    await expect(
      installExtension({ root: tempRoot(), repo: "owner/demo", deps }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: expect.stringContaining("https"),
    });
  });

  it("仓库格式必须是 owner/name", async () => {
    await expect(
      installExtension({ root: tempRoot(), repo: "not-a-repo", deps: fakeDeps() }),
    ).rejects.toMatchObject({ code: "PLUGIN_FAILED", exitCode: 4 });
  });
});

describe("解析 SHA256SUMS", () => {
  it("支持下划线、星号与 ./ 前缀", () => {
    const parsed = parseChecksums(
      [
        "# comment",
        `${"a".repeat(64)}  asg-extension.json`,
        `${"b".repeat(64)} *index.mjs`,
        `${"c".repeat(64)}  ./extra.js`,
        "not a checksum",
        "",
      ].join("\n"),
    );
    expect(parsed.get("asg-extension.json")).toBe("a".repeat(64));
    expect(parsed.get("index.mjs")).toBe("b".repeat(64));
    expect(parsed.get("extra.js")).toBe("c".repeat(64));
    expect(parsed.size).toBe(3);
  });
});

describe("列出与卸载扩展", () => {
  function writeExtension(
    root: string,
    dir: string,
    text: string,
    fileName = "asg-extension.json",
  ): void {
    const target = path.join(extensionsPath(root), dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, fileName), text, "utf8");
  }

  it("读取有效目录，坏包返回 error 而不抛整条命令", () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", JSON.stringify(MANIFEST));
    writeExtension(root, "broken", "{");
    fs.mkdirSync(path.join(extensionsPath(root), ".staging-x"), { recursive: true });

    const list = listExtensions(root);

    expect(list.map((item) => item.id)).toEqual(["broken", "demo-fetch"]);
    expect(list[0]).toMatchObject({
      id: "broken",
      path: path.join(extensionsPath(root), "broken"),
      error: expect.stringContaining("JSON"),
    });
    expect(list[1]).toMatchObject({
      id: "demo-fetch",
      name: "Demo Fetch",
      version: "1.2.3",
      provides: ["fetch"],
      backends: [],
      entry: "index.mjs",
      path: path.join(extensionsPath(root), "demo-fetch"),
    });
    expect(list[1]!.error).toBeUndefined();
  });

  it("只有 asg-plugin.json 时提示升级插件", () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-fetch",
      JSON.stringify({ ...MANIFEST, api_version: 1 }),
      "asg-plugin.json",
    );

    const item = listExtensions(root)[0]!;
    expect(item.id).toBe("demo-fetch");
    expect(item.error).toContain("未找到 asg-extension.json");
    expect(item.error).toContain("asg extensions install");
  });

  it("没有 manifest 时提示未找到 asg-extension.json", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(extensionsPath(root), "no-manifest"), { recursive: true });

    const item = listExtensions(root)[0]!;
    expect(item.error).toContain("未找到 asg-extension.json");
    expect(item.error).not.toContain("asg extensions install");
  });

  it("目录名与 manifest.id 不一致时标记 error", () => {
    const root = tempRoot();
    writeExtension(root, "wrong-dir", JSON.stringify(MANIFEST));

    const item = listExtensions(root)[0]!;
    expect(item.id).toBe("demo-fetch");
    expect(item.error).toContain("目录名");
  });

  it("扩展目录不存在时返回空数组", () => {
    expect(listExtensions(tempRoot())).toEqual([]);
  });

  it("卸载删除目录", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", JSON.stringify(MANIFEST));

    await expect(removeExtension(root, "demo-fetch")).resolves.toEqual({
      id: "demo-fetch",
      removed: true,
    });
    expect(fs.existsSync(path.join(extensionsPath(root), "demo-fetch"))).toBe(false);
  });

  it("允许卸载官方 id；非法 id 与不存在的目录仍拒绝", async () => {
    const root = tempRoot();
    writeExtension(root, "bilibili", JSON.stringify({ ...MANIFEST, id: "bilibili" }));

    await expect(removeExtension(root, "bilibili")).resolves.toEqual({
      id: "bilibili",
      removed: true,
    });
    expect(fs.existsSync(path.join(extensionsPath(root), "bilibili"))).toBe(false);

    await expect(removeExtension(root, "Bad")).rejects.toMatchObject({
      code: "PLUGIN_UNKNOWN",
      exitCode: 4,
    });
    await expect(removeExtension(root, "nope")).rejects.toMatchObject({
      code: "PLUGIN_UNKNOWN",
      message: expect.stringContaining("未安装"),
    });
  });
});

describe("搜索扩展", () => {
  it("拼装 topic 查询并带 GitHub 请求头", async () => {
    const fetchJson = vi.fn(async () => ({
      items: [
        {
          full_name: "owner/demo",
          description: "示例",
          html_url: "https://github.com/owner/demo",
          stargazers_count: 7,
          updated_at: "2026-01-01T00:00:00Z",
        },
        { full_name: 123 },
      ],
    }));

    const results = await searchExtensions({
      query: "bilibili",
      limit: 5,
      token: "tkn",
      userAgent: "asg/test",
      deps: { fetchJson },
    });

    const [url, request] = fetchJson.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      "https://api.github.com/search/repositories",
    );
    expect(parsed.searchParams.get("q")).toBe(
      "topic:asg-plugin fork:false archived:false bilibili in:name,description",
    );
    expect(parsed.searchParams.get("sort")).toBe("updated");
    expect(parsed.searchParams.get("order")).toBe("desc");
    expect(parsed.searchParams.get("per_page")).toBe("5");
    expect(request.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "asg/test",
      Authorization: "Bearer tkn",
    });

    expect(results).toEqual([
      {
        repo: "owner/demo",
        description: "示例",
        url: "https://github.com/owner/demo",
        stars: 7,
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("从 GITHUB_TOKEN / GH_TOKEN 读取 token", async () => {
    const fetchJson = vi.fn(async () => ({ items: [] }));

    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "gh-token");
    await searchExtensions({ deps: { fetchJson } });
    let request = fetchJson.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(request.headers.Authorization).toBe("Bearer gh-token");

    vi.stubEnv("GITHUB_TOKEN", "github-token");
    fetchJson.mockClear();
    await searchExtensions({ deps: { fetchJson } });
    request = fetchJson.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(request.headers.Authorization).toBe("Bearer github-token");
  });

  it("403/429 给出设置 GITHUB_TOKEN 的中文提示", async () => {
    const fetchJson = vi.fn(async () => {
      throw new Error("HTTP 403: API rate limit exceeded");
    });
    await expect(searchExtensions({ deps: { fetchJson } })).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: expect.stringContaining("GITHUB_TOKEN"),
    });
  });

  it("limit 必须在 1..100", async () => {
    for (const limit of [0, 101, 1.5]) {
      await expect(searchExtensions({ limit, deps: { fetchJson: vi.fn() } })).rejects.toMatchObject(
        { code: "PLUGIN_FAILED", exitCode: 4 },
      );
    }
  });
});
