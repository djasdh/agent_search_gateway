import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/settings/index.js";
import type { FetchPluginContext } from "../src/fetch/plugins/types.js";
import { bilibiliPlugin, buildArticleSummary, buildVideoSummary } from "../src/bilibili/index.js";
import { createCommentStore } from "../src/bilibili/store.js";
import { isBiliContentUrl, parseBiliRequest } from "../src/bilibili/parse.js";
import type { BiliArticle, BiliComment, BiliDetail } from "../src/bilibili/types.js";

const dirs: string[] = [];

function cfg(yaml = "gateway: { host: 127.0.0.1 }\nbilibili: { enabled: true }\n"): FetchPluginContext {
  const d = mkdtempSync(join(tmpdir(), "bili-test-"));
  dirs.push(d);
  const p = join(d, "gateway.yaml");
  writeFileSync(p, yaml);
  const { settings, secrets } = loadSettings({ configPath: p, secretsPath: join(d, "secrets.yaml"), env: {} });
  return {
    settings: { fetch: settings.fetch, bilibili: settings.bilibili },
    secrets: { bilibili: { http: { token: secrets.bilibili.http.token } } },
  };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parse", () => {
  it("视频按路径识别，p 保留", () => {
    const p = parseBiliRequest(new URL("https://www.bilibili.com/video/BV1xx411c7mD?p=3&spm_id_from=x"));
    expect(p.action).toBe("video");
    expect(p.ref.bvid).toBe("BV1xx411c7mD");
    expect(p.ref.page).toBe(3);
    expect(p.ref.raw).toBe("https://www.bilibili.com/video/BV1xx411c7mD?p=3");
  });

  it("av 视频识别 aid", () => {
    const p = parseBiliRequest(new URL("https://www.bilibili.com/video/av123"));
    expect(p.action).toBe("video");
    expect(p.ref.aid).toBe(123);
    expect(p.ref.raw).toBe("https://www.bilibili.com/video/av123");
  });

  it("旧 bili 参数被忽略", () => {
    const p = parseBiliRequest(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=audio"));
    expect(p.action).toBe("video");
  });

  it("专栏按路径识别", () => {
    const p = parseBiliRequest(new URL("https://www.bilibili.com/read/cv123456"));
    expect(p.action).toBe("article");
    expect(p.ref.cv).toBe("123456");
    expect(p.ref.raw).toBe("https://www.bilibili.com/read/cv123456");
  });

  it("#reply / #comment 进入评论", () => {
    expect(parseBiliRequest(new URL("https://www.bilibili.com/video/BV1xx411c7mD#reply")).action).toBe("comments");
    expect(parseBiliRequest(new URL("https://www.bilibili.com/read/cv123#comment")).action).toBe("comments");
  });

  it("hash 内的 q 与 sort", () => {
    const p = parseBiliRequest(new URL("https://www.bilibili.com/video/BV1xx411c7mD#reply?q=世界&sort=time"));
    expect(p.action).toBe("comments_search");
    expect(p.query).toBe("世界");
    expect(p.sort).toBe("time");
  });

  it("不支持的路径报 BILI_INVALID_URL", () => {
    expect(() => parseBiliRequest(new URL("https://www.bilibili.com/bangumi/play/ep1"))).toThrow();
  });
});

describe("plugin match", () => {
  it("视频、专栏、短链命中；空间页不命中", () => {
    expect(bilibiliPlugin.match(new URL("https://www.bilibili.com/video/BV1xx411c7mD"))).toBe(true);
    expect(bilibiliPlugin.match(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=video"))).toBe(true);
    expect(bilibiliPlugin.match(new URL("https://www.bilibili.com/read/cv123"))).toBe(true);
    expect(bilibiliPlugin.match(new URL("https://b23.tv/abc"))).toBe(true);
    expect(bilibiliPlugin.match(new URL("https://space.bilibili.com/1"))).toBe(false);
    expect(bilibiliPlugin.match(new URL("https://example.com/video/BV1xx411c7mD"))).toBe(false);
  });

  it("路径判定只认视频和专栏", () => {
    expect(isBiliContentUrl(new URL("https://www.bilibili.com/video/av123"))).toBe(true);
    expect(isBiliContentUrl(new URL("https://www.bilibili.com/opus/123"))).toBe(false);
  });

  it("enabled=false 明确报不可用", async () => {
    const config = cfg("gateway: { host: 127.0.0.1 }\nbilibili: { enabled: false }\n");
    const r = await bilibiliPlugin.fetch(new URL("https://www.bilibili.com/video/BV1xx411c7mD"), config);
    expect(r).toMatchObject({ ok: false, errorCode: "BILI_UNAVAILABLE" });
  });
});

describe("summary", () => {
  const detail: BiliDetail = {
    bvid: "BV1xx411c7mD",
    title: "标题",
    desc: "简介",
    owner: { mid: 1, name: "UP" },
    stat: { view: 10, like: 2 },
    cover: "https://cover",
    pages: [{ page: 1, title: "P1" }, { page: 2, title: "P2" }],
    currentPage: 2,
    pageCount: 2,
  };
  const ref = { raw: "https://www.bilibili.com/video/BV1xx411c7mD?p=2" };

  it("视频摘要字段齐全", () => {
    const s = buildVideoSummary(detail, ref, "https://audio");
    expect(s).toMatchObject({
      kind: "video",
      audio_url: "https://audio",
      cover_url: "https://cover",
      comments_url: `${ref.raw}#reply`,
    });
    expect(s.detail.current_page).toBe(2);
    expect(s.detail.page_count).toBe(2);
    expect(s.detail.pages).toEqual([{ page: 1, title: "P1" }, { page: 2, title: "P2" }]);
    expect(s.audio_error).toBeUndefined();
  });

  it("音频失败降级为 null + audio_error", () => {
    const s = buildVideoSummary(detail, ref, null, "风控");
    expect(s.audio_url).toBeNull();
    expect(s.audio_error).toBe("风控");
  });

  it("专栏摘要 audio_url 为 null", () => {
    const article: BiliArticle = { cv: "123", title: "专栏", content: "正文", meta: { cover: "https://cover" } };
    const s = buildArticleSummary(article, { raw: "https://www.bilibili.com/read/cv123" });
    expect(s.audio_url).toBeNull();
    expect(s.cover_url).toBe("https://cover");
    expect(s.comments_url).toBe("https://www.bilibili.com/read/cv123#comment");
  });
});

describe("http 端到端", () => {
  it("摘要、评论、检索走通", async () => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      const send = (data: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/health") return send({ ok: true, loggedIn: true });
      if (url.pathname === "/detail") {
        return send({
          ok: true,
          data: {
            bvid: "BV1xx411c7mD", title: "标题", desc: "简介",
            owner: { mid: 1, name: "UP" }, stat: { view: 10 }, cover: "https://cover",
            pages: [{ page: 1, title: "P1" }, { page: 2, title: "P2" }],
          },
        });
      }
      if (url.pathname === "/playurl") return send({ ok: true, data: { url: "https://cdn.example/audio.m4s" } });
      if (url.pathname === "/comments") {
        return send({
          ok: true,
          data: {
            bvid: "BV1xx411c7mD", page: 1, total: 1, hasMore: false, nextPage: 2,
            items: [{ rpid: 1, mid: 1, uname: "u", content: "hello world", like: 1, ctime: 1 }],
          },
        });
      }
      if (url.pathname === "/article") {
        return send({ ok: true, data: { cv: "123", title: "专栏", content: "正文", meta: { cover: "https://cover" } } });
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const d = mkdtempSync(join(tmpdir(), "bili-e2e-"));
    dirs.push(d);
    const config = cfg(`gateway: { host: 127.0.0.1 }
bilibili:
  enabled: true
  comment_db: ${join(d, "comments.sqlite")}
  routes:
    detail: [http]
    comments: [http]
    audio: [http]
    article: [http]
  http:
    base_url: http://127.0.0.1:${port}
    request_timeout_ms: 5000
`);

    try {
      const video = await bilibiliPlugin.fetch(new URL("https://www.bilibili.com/video/BV1xx411c7mD?p=2"), config);
      expect(video.ok).toBe(true);
      const body = JSON.parse(video.bytes!.toString("utf8"));
      expect(body.audio_url).toBe("https://cdn.example/audio.m4s");
      expect(body.detail.current_page).toBe(2);
      expect(body.detail.page_count).toBe(2);
      expect(body.comments_url).toBe("https://www.bilibili.com/video/BV1xx411c7mD?p=2#reply");

      const comments = await bilibiliPlugin.fetch(new URL("https://www.bilibili.com/video/BV1xx411c7mD#reply"), config);
      const cbody = JSON.parse(comments.bytes!.toString("utf8"));
      expect(cbody).toMatchObject({ kind: "comments", fetched: 1, complete: true });
      expect(cbody.sample[0].content).toBe("hello world");

      const search = await bilibiliPlugin.fetch(new URL("https://www.bilibili.com/video/BV1xx411c7mD#reply?q=hello"), config);
      const sbody = JSON.parse(search.bytes!.toString("utf8"));
      expect(sbody).toMatchObject({ kind: "comments_search", q: "hello", count: 1 });
    } finally {
      server.close();
    }
  });
});

describe("comment store", () => {
  it("落库、展开楼中楼、检索、断点", () => {
    const d = mkdtempSync(join(tmpdir(), "bili-store-"));
    dirs.push(d);
    const store = createCommentStore(join(d, "c.sqlite"));
    const items: BiliComment[] = [
      {
        rpid: 1, mid: 10, uname: "a", content: "hello 世界", like: 7, ctime: 1,
        replies: [{ rpid: 2, root: 1, parent: 1, mid: 11, uname: "b", content: "reply", like: 1, ctime: 2 }],
      },
      { rpid: 3, mid: 12, uname: "c", content: "another 世界", like: 3, ctime: 3 },
    ];
    store.upsertPage({ bvid: "BV1xx411c7mD", page: 1, items, hasMore: true });
    expect(store.count("BV1xx411c7mD")).toBe(3);
    expect(store.syncState("BV1xx411c7mD")).toEqual({ nextPage: 2, finished: false });
    expect(store.search("BV1xx411c7mD", "世界")).toHaveLength(2);
    expect(store.search("BV1xx411c7mD", "reply", { mid: 11 })).toHaveLength(1);
    store.upsertPage({ bvid: "BV1xx411c7mD", page: 2, items: [], hasMore: false });
    expect(store.syncState("BV1xx411c7mD").finished).toBe(true);
    store.close();
  });
});
