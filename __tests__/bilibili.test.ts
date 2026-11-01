import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type GatewayConfig } from "../src/config.js";
import { bilibiliPlugin } from "../src/bilibili/index.js";
import { downloadStream } from "../src/bilibili/download.js";
import { createCommentStore } from "../src/bilibili/store.js";
import { parseBiliRequest, isBilibiliUrl } from "../src/bilibili/parse.js";
import { BiliError } from "../src/bilibili/types.js";
import type { BiliComment } from "../src/bilibili/types.js";
import { extForContentType } from "../src/fetch/convert.js";

const dirs: string[] = [];
const servers: Server[] = [];

function tempConfig(yaml: string): GatewayConfig {
  const d = mkdtempSync(join(tmpdir(), "bili-test-"));
  dirs.push(d);
  const p = join(d, "gateway.yaml");
  writeFileSync(p, yaml);
  return loadConfig(p);
}

function localConfig(maxBytes = 1024): GatewayConfig {
  return tempConfig(`
gateway: { host: 127.0.0.1 }
bilibili:
  enabled: true
  download:
    allow_private_cdn: true
    allowed_hosts: ["127.0.0.1"]
    max_bytes: ${maxBytes}
`);
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("bilibili parse", () => {
  const config = localConfig();

  it("识别 bilibili 与 b23.tv", () => {
    expect(isBilibiliUrl(new URL("https://www.bilibili.com/video/BV1xx411c7mD"))).toBe(true);
    expect(isBilibiliUrl(new URL("https://space.bilibili.com/1"))).toBe(true);
    expect(isBilibiliUrl(new URL("https://b23.tv/abc"))).toBe(true);
    expect(isBilibiliUrl(new URL("https://example.com/video/BV1xx411c7mD"))).toBe(false);
  });

  it("bili=video/audio 映射成 media + kind", () => {
    const video = parseBiliRequest(
      new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=video&p=2"),
      config,
    );
    expect(video.action).toBe("media");
    expect(video.kind).toBe("video");
    expect(video.ref.bvid).toBe("BV1xx411c7mD");
    expect(video.page).toBe(2);

    const audio = parseBiliRequest(
      new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=audio"),
      config,
    );
    expect(audio.action).toBe("media");
    expect(audio.kind).toBe("audio");

    const media = parseBiliRequest(
      new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=media&kind=audio"),
      config,
    );
    expect(media.kind).toBe("audio");
  });

  it("解析 comments / comments_search / article", () => {
    const comments = parseBiliRequest(
      new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=comments&page=3&sort=time&all=1"),
      config,
    );
    expect(comments.action).toBe("comments");
    expect(comments.page).toBe(3);
    expect(comments.sort).toBe("time");
    expect(comments.all).toBe(true);

    const search = parseBiliRequest(
      new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=comments_search&q=hello"),
      config,
    );
    expect(search.action).toBe("comments_search");
    expect(search.query).toBe("hello");

    const article = parseBiliRequest(
      new URL("https://www.bilibili.com/read/cv123456?bili=article"),
      config,
    );
    expect(article.action).toBe("article");
    expect(article.ref.cv).toBe("123456");
  });

  it("非法动作/缺参数抛 BILI_INVALID_URL", () => {
    for (const url of [
      "https://www.bilibili.com/video/BV1xx411c7mD?bili=nope",
      "https://www.bilibili.com/video/BV1xx411c7mD?bili=comments_search",
      "https://www.bilibili.com/read/cv123456?bili=detail",
      "https://www.bilibili.com/video/BV1xx411c7mD?bili=article",
    ]) {
      try {
        parseBiliRequest(new URL(url), config);
        throw new Error(`应当抛错: ${url}`);
      } catch (err) {
        expect(err).toBeInstanceOf(BiliError);
        expect((err as BiliError).code).toBe("BILI_INVALID_URL");
      }
    }
  });
});

describe("bilibili plugin gating", () => {
  it("没有 bili 参数不接管", () => {
    const config = localConfig();
    expect(bilibiliPlugin.match(new URL("https://www.bilibili.com/video/BV1xx411c7mD"))).toBe(false);
    expect(
      bilibiliPlugin.match(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=detail")),
    ).toBe(true);
  });

  it("enabled=false 时明确报不可用", async () => {
    const config = tempConfig(`
gateway: { host: 127.0.0.1 }
bilibili:
  enabled: false
`);
    const r = await bilibiliPlugin.fetch(
      new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=video"),
      { config },
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("BILI_UNAVAILABLE");
    expect(r.errorMessage).toContain("bilibili.enabled=false");
  });
});

describe("comment store", () => {
  it("upsert / 楼中楼展开 / 检索 / 断点", () => {
    const d = mkdtempSync(join(tmpdir(), "bili-store-"));
    dirs.push(d);
    const store = createCommentStore(join(d, "comments.sqlite"));

    const items: BiliComment[] = [
      {
        rpid: 1,
        root: null,
        parent: null,
        mid: 10,
        uname: "alice",
        content: "hello 世界",
        like: 7,
        ctime: 100,
        replies: [
          {
            rpid: 2,
            root: 1,
            parent: 1,
            mid: 11,
            uname: "bob",
            content: "reply 内容",
            like: 1,
            ctime: 101,
          },
        ],
      },
      {
        rpid: 3,
        root: null,
        parent: null,
        mid: 12,
        uname: "carol",
        content: "another 世界",
        like: 3,
        ctime: 102,
      },
    ];

    store.upsertPage({ bvid: "BV1xx411c7mD", page: 1, items, hasMore: true });

    expect(store.count("BV1xx411c7mD")).toBe(3);
    expect(store.syncState("BV1xx411c7mD")).toEqual({ nextPage: 2, finished: false });

    const hits = store.search("BV1xx411c7mD", "世界");
    expect(hits.length).toBe(2);
    expect(hits[0]!.like).toBe(7);

    const byUser = store.search("BV1xx411c7mD", "reply", { mid: 11 });
    expect(byUser.length).toBe(1);

    store.upsertPage({ bvid: "BV1xx411c7mD", page: 2, items: [], hasMore: false });
    expect(store.syncState("BV1xx411c7mD").finished).toBe(true);
    store.close();
  });
});

describe("download guardrails", () => {
  function serve(
    handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  ): Promise<string> {
    return new Promise((resolve) => {
      const s = createServer(handler);
      servers.push(s);
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}/media`);
      });
    });
  }

  it("正常下载并沿用 contentType", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.from("hello"));
    });
    const config = localConfig();
    const r = await downloadStream({ url, contentType: "video/mp4" }, config);
    expect(r.bytes.toString()).toBe("hello");
    expect(r.contentType).toBe("video/mp4");
  });

  it("403/412 映射 BILI_RISK_CONTROL", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(412);
      res.end("blocked");
    });
    const config = localConfig();
    await expect(downloadStream({ url, contentType: "video/mp4" }, config)).rejects.toMatchObject({
      code: "BILI_RISK_CONTROL",
    });
  });

  it("超过 max_bytes 中止", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.alloc(4096, 1));
    });
    const config = localConfig(64);
    await expect(downloadStream({ url, contentType: "video/mp4" }, config)).rejects.toMatchObject({
      code: "BILI_DOWNLOAD_FAIL",
    });
  });

  it("白名单外主机拒绝", async () => {
    const config = localConfig();
    await expect(
      downloadStream({ url: "https://example.com/a.mp4", contentType: "video/mp4" }, config),
    ).rejects.toMatchObject({ code: "BILI_INVALID_URL" });
  });
});

describe("content type 扩展名", () => {
  it("audio/mp4 落盘为 .m4a", () => {
    expect(extForContentType("audio/mp4")).toBe(".m4a");
  });
});
