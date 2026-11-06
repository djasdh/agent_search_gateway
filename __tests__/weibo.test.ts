import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type GatewayConfig } from "../src/config.js";
import { downloadWeiboImage } from "../src/weibo/images.js";
import { weiboPlugin } from "../src/weibo/index.js";
import { addDays, isWeiboImageUrl, isWeiboUrl, parseWeiboRequest, todayInShanghai } from "../src/weibo/parse.js";
import { WeiboError } from "../src/weibo/types.js";

const dirs: string[] = [];
const servers: Server[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "weibo-test-"));
  dirs.push(d);
  return d;
}

const FAKE_CLI = `#!/usr/bin/env bash
set -e
cmd="$2"
id="$3"
[ -n "$FAKE_LOG" ] && echo "$cmd $id" >> "$FAKE_LOG"
case "$cmd" in
  post)
    if [ "$id" = "fail77" ]; then echo "not logged in" >&2; exit 77; fi
    cat <<'JSON'
[{"field":"id","value":"5123456789"},{"field":"mblogid","value":"AbCdEf"},{"field":"author","value":"测试作者"},{"field":"text","value":"正文内容"},{"field":"pic_count","value":"2"},{"field":"pic_urls","value":"[{\\"url\\":\\"https://wx1.sinaimg.cn/large/a.jpg\\"},{\\"url\\":\\"https://wx2.sinaimg.cn/large/b.jpg\\"}]"},{"field":"retweeted_text","value":"转发正文"},{"field":"reposts","value":"3"},{"field":"comments","value":"4"},{"field":"likes","value":"5"},{"field":"url","value":"https://weibo.com/1/AbCdEf"}]
JSON
    ;;
  comments)
    printf '[{"author":"c1","text":"评论1"}]\\n'
    ;;
  user)
    printf '{"screen_name":"测试作者","uid":"1"}\\n'
    ;;
  user-posts)
    printf '[{"id":"AbCdEf","text":"用户微博"}]\\n'
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
`;

function makeConfig(): GatewayConfig {
  const d = tmpDir();
  const cli = join(d, "fake-opencli.sh");
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  const yaml = [
    "gateway: { host: 127.0.0.1 }",
    "weibo:",
    "  enabled: true",
    `  cli: { command: "${cli}", timeout_ms: 5000 }`,
    "  cache_ttl_ms: 0",
    "",
  ].join("\n");
  const path = join(d, "gateway.yaml");
  writeFileSync(path, yaml);
  return loadConfig(path);
}

function disabledConfig(): GatewayConfig {
  const d = tmpDir();
  const path = join(d, "gateway.yaml");
  writeFileSync(path, "gateway: { host: 127.0.0.1 }\nweibo: { enabled: false }\n");
  return loadConfig(path);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.close();
  delete process.env.FAKE_LOG;
});

describe("parse", () => {
  const config = () => makeConfig();

  it("主站帖子路径 → post", () => {
    const ref = parseWeiboRequest(new URL("https://weibo.com/1234567890/AbCdEf?weibo=post"), config());
    expect(ref).toMatchObject({ action: "post", uid: "1234567890", mblogid: "AbCdEf" });
  });

  it("detail/status 路径 → post + id", () => {
    expect(parseWeiboRequest(new URL("https://weibo.com/detail/AbCdEf?weibo=post"), config())).toMatchObject({
      action: "post",
      id: "AbCdEf",
    });
    expect(parseWeiboRequest(new URL("https://m.weibo.cn/status/5123456789?weibo=post"), config())).toMatchObject({
      action: "post",
      id: "5123456789",
    });
  });

  it("comments 带 limit，越界 clamp 到 50", () => {
    const ref = parseWeiboRequest(new URL("https://m.weibo.cn/detail/5123456789?weibo=comments&limit=999"), config());
    expect(ref).toMatchObject({ action: "comments", id: "5123456789", limit: 50 });
  });

  it("用户页支持 uid 与昵称", () => {
    expect(parseWeiboRequest(new URL("https://weibo.com/u/1234567890?weibo=user"), config())).toMatchObject({
      action: "user",
      uid: "1234567890",
    });
    expect(parseWeiboRequest(new URL("https://weibo.com/n/%E9%9B%B7%E5%86%9B?weibo=user"), config())).toMatchObject({
      action: "user",
      screenName: "雷军",
    });
  });

  it("user-posts 带日期与 limit", () => {
    const ref = parseWeiboRequest(
      new URL("https://weibo.com/1234567890?weibo=user-posts&limit=10&start=2026-01-01&end=2026-02-01"),
      config(),
    );
    expect(ref).toMatchObject({
      action: "user-posts",
      limit: 10,
      start: "2026-01-01",
      end: "2026-02-01",
    });
  });

  it("user-posts 默认最近 7 天", () => {
    const ref = parseWeiboRequest(new URL("https://weibo.com/u/1234567890?weibo=user-posts"), config());
    const today = todayInShanghai();
    expect(ref).toMatchObject({
      start: addDays(today, -6),
      end: today,
      limit: 100,
    });
  });

  it("user-posts days=30 与只给 end", () => {
    const today = todayInShanghai();
    expect(parseWeiboRequest(new URL("https://weibo.com/u/1?weibo=user-posts&days=30"), config())).toMatchObject({
      start: addDays(today, -29),
      end: today,
      days: 30,
    });
    expect(
      parseWeiboRequest(new URL("https://weibo.com/u/1?weibo=user-posts&end=2026-02-10"), config()),
    ).toMatchObject({
      start: "2026-02-04",
      end: "2026-02-10",
    });
  });

  it("user-posts days 与 start/end 互斥、跨度受限", () => {
    expect(() =>
      parseWeiboRequest(new URL("https://weibo.com/u/1?weibo=user-posts&days=7&start=2026-01-01"), config()),
    ).toThrow(/不能与 start\/end/);
    expect(() =>
      parseWeiboRequest(new URL("https://weibo.com/u/1?weibo=user-posts&days=0"), config()),
    ).toThrow(/days/);
    expect(() =>
      parseWeiboRequest(
        new URL("https://weibo.com/u/1?weibo=user-posts&start=2026-01-01&end=2026-06-01"),
        config(),
      ),
    ).toThrow(/跨度/);
  });

  it("user-posts max_items 被配置上限收敛", () => {
    const ref = parseWeiboRequest(
      new URL("https://weibo.com/u/1?weibo=user-posts&days=7&max_items=9999"),
      config(),
    );
    expect(ref.maxItems).toBe(500);
  });

  it("search/hot/image 本轮不支持", () => {
    expect(() => parseWeiboRequest(new URL("https://weibo.com/?weibo=search&q=x"), config())).toThrow(WeiboError);
    expect(() => parseWeiboRequest(new URL("https://weibo.com/?weibo=hot"), config())).toThrow(WeiboError);
    expect(() => parseWeiboRequest(new URL("https://weibo.com/?weibo=image"), config())).toThrow(WeiboError);
  });

  it("非法 start 报 WEIBO_INVALID", () => {
    expect(() =>
      parseWeiboRequest(new URL("https://weibo.com/1234567890?weibo=user-posts&start=2026/01/01"), config()),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("image url", () => {
  it("sinaimg 图片路径命中", () => {
    expect(isWeiboImageUrl(new URL("https://wx1.sinaimg.cn/large/abc.jpg"))).toBe(true);
    expect(isWeiboImageUrl(new URL("https://tvax1.sinaimg.cn/crop.0.0.1080.1080.1024/abc.jpg"))).toBe(true);
  });

  it("同域非图片不命中", () => {
    expect(isWeiboImageUrl(new URL("https://wx1.sinaimg.cn/static/app.css"))).toBe(false);
    expect(isWeiboImageUrl(new URL("https://example.com/large/a.jpg"))).toBe(false);
  });

  it("isWeiboUrl 覆盖主站/m 站/t.cn", () => {
    expect(isWeiboUrl(new URL("https://weibo.com/1/AbC"))).toBe(true);
    expect(isWeiboUrl(new URL("https://m.weibo.cn/detail/1"))).toBe(true);
    expect(isWeiboUrl(new URL("https://t.cn/abc"))).toBe(true);
    expect(isWeiboUrl(new URL("https://example.com/1/AbC"))).toBe(false);
  });
});

describe("plugin match", () => {
  it("普通页面必须带 ?weibo=，图片 URL 自动命中", () => {
    const config = makeConfig();
    expect(weiboPlugin.match(new URL("https://weibo.com/1/AbC?weibo=post"), config)).toBe(true);
    expect(weiboPlugin.match(new URL("https://weibo.com/1/AbC"), config)).toBe(false);
    expect(weiboPlugin.match(new URL("https://wx1.sinaimg.cn/large/a.jpg"), config)).toBe(true);
    expect(weiboPlugin.match(new URL("https://example.com/1/AbC?weibo=post"), config)).toBe(false);
  });

  it("配置关闭时不接管，保证回退 generic", () => {
    const config = disabledConfig();
    expect(weiboPlugin.match(new URL("https://wx1.sinaimg.cn/large/a.jpg"), config)).toBe(false);
    expect(weiboPlugin.match(new URL("https://weibo.com/1/AbC?weibo=post"), config)).toBe(false);
  });
});

describe("plugin fetch", () => {
  it("post 渲染 Markdown 并列出全部图片外链", async () => {
    const config = makeConfig();
    const result = await weiboPlugin.fetch(new URL("https://weibo.com/1/AbCdEf?weibo=post"), { config });
    expect(result.ok).toBe(true);
    expect(result.contentType).toBe("text/markdown");
    const text = result.bytes?.toString("utf8") ?? "";
    expect(text).toContain("测试作者");
    expect(text).toContain("正文内容");
    expect(text).toContain("转发正文");
    expect(text).toContain("![](https://wx1.sinaimg.cn/large/a.jpg)");
    expect(text).toContain("![](https://wx2.sinaimg.cn/large/b.jpg)");
    expect(text).toContain("转发：3");
  });

  it("comments 的 mblogid 先 post 换 numeric id", async () => {
    const config = makeConfig();
    const log = join(tmpDir(), "calls.log");
    process.env.FAKE_LOG = log;
    const result = await weiboPlugin.fetch(new URL("https://weibo.com/1/AbCdEf?weibo=comments"), { config });
    expect(result.ok).toBe(true);
    expect(result.contentType).toBe("application/json");
    expect(result.bytes?.toString("utf8")).toContain("评论1");
    expect(readFileSync(log, "utf8")).toBe("post AbCdEf\ncomments 5123456789\n");
  });

  it("user / user-posts 返回 JSON", async () => {
    const config = makeConfig();
    const user = await weiboPlugin.fetch(new URL("https://weibo.com/u/1?weibo=user"), { config });
    expect(user.bytes?.toString("utf8")).toContain("测试作者");
    const posts = await weiboPlugin.fetch(new URL("https://weibo.com/u/1?weibo=user-posts"), { config });
    expect(posts.bytes?.toString("utf8")).toContain("用户微博");
  });

  it("退出码 77 → WEIBO_AUTH_REQUIRED", async () => {
    const config = makeConfig();
    const result = await weiboPlugin.fetch(new URL("https://weibo.com/detail/fail77?weibo=post"), { config });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("WEIBO_AUTH_REQUIRED");
  });

  it("未启用 → WEIBO_UNAVAILABLE", async () => {
    const result = await weiboPlugin.fetch(new URL("https://weibo.com/1/AbC?weibo=post"), {
      config: disabledConfig(),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("WEIBO_UNAVAILABLE");
  });

  it("缓存命中后不再调用 CLI", async () => {
    const d = tmpDir();
    const cli = join(d, "fake-opencli.sh");
    writeFileSync(cli, FAKE_CLI);
    chmodSync(cli, 0o755);
    const log = join(d, "calls.log");
    process.env.FAKE_LOG = log;
    const path = join(d, "gateway.yaml");
    writeFileSync(
      path,
      [
        "gateway: { host: 127.0.0.1 }",
        "weibo:",
        "  enabled: true",
        `  cli: { command: "${cli}", timeout_ms: 5000 }`,
        "  cache_ttl_ms: 60000",
        "",
      ].join("\n"),
    );
    const config = loadConfig(path);
    const url = new URL("https://weibo.com/1/Cached?weibo=post");
    await weiboPlugin.fetch(url, { config });
    await weiboPlugin.fetch(url, { config });
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("image download", () => {
  async function startServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  function imageConfig(maxBytes = 1024): GatewayConfig {
    const d = tmpDir();
    const path = join(d, "gateway.yaml");
    writeFileSync(
      path,
      [
        "gateway: { host: 127.0.0.1 }",
        "weibo:",
        "  enabled: true",
        "  images:",
        `    max_bytes: ${maxBytes}`,
        "",
      ].join("\n"),
    );
    return loadConfig(path);
  }

  it("带 Referer 下载图片", async () => {
    let referer = "";
    const base = await startServer((req, res) => {
      referer = String(req.headers.referer ?? "");
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    const result = await downloadWeiboImage(new URL(`${base}/large/a.png`), imageConfig());
    expect(result.contentType).toBe("image/png");
    expect(result.bytes.length).toBe(4);
    expect(referer).toBe("https://weibo.com/");
  });

  it("非图片类型报 WEIBO_IMAGE_FAIL", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("nope");
    });
    await expect(downloadWeiboImage(new URL(`${base}/large/a.jpg`), imageConfig())).rejects.toMatchObject({
      code: "WEIBO_IMAGE_FAIL",
    });
  });

  it("超过大小上限报 WEIBO_IMAGE_FAIL", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(64, 1));
    });
    await expect(downloadWeiboImage(new URL(`${base}/large/a.png`), imageConfig(10))).rejects.toMatchObject({
      code: "WEIBO_IMAGE_FAIL",
    });
  });
});
