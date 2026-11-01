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
import { BiliError, type BiliComment } from "../src/bilibili/types.js";
import { extForContentType } from "../src/fetch/convert.js";

const dirs: string[] = [];
const servers: Server[] = [];

function cfg(yaml: string): GatewayConfig {
  const d = mkdtempSync(join(tmpdir(), "bili-test-"));
  dirs.push(d);
  const p = join(d, "gateway.yaml");
  writeFileSync(p, yaml);
  return loadConfig(p);
}

const localCfg = (maxBytes = 1024) => cfg(`
gateway: { host: 127.0.0.1 }
bilibili:
  enabled: true
  download: { allow_private_cdn: true, allowed_hosts: ["127.0.0.1"], max_bytes: ${maxBytes} }
`);

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parse", () => {
  const config = localCfg();

  it("识别域名", () => {
    expect(isBilibiliUrl(new URL("https://www.bilibili.com/video/BV1xx411c7mD"))).toBe(true);
    expect(isBilibiliUrl(new URL("https://b23.tv/x"))).toBe(true);
    expect(isBilibiliUrl(new URL("https://example.com/video/BV1xx411c7mD"))).toBe(false);
  });

  it("video/audio 映射到 media", () => {
    const v = parseBiliRequest(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=video&p=2"), config);
    expect(v).toMatchObject({ action: "media", kind: "video", page: 2 });
    const a = parseBiliRequest(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=audio"), config);
    expect(a.kind).toBe("audio");
  });

  it("comments / comments_search / article", () => {
    const c = parseBiliRequest(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=comments&page=3&sort=time&all=1"), config);
    expect(c).toMatchObject({ action: "comments", page: 3, sort: "time", all: true });
    const s = parseBiliRequest(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=comments_search&q=hi"), config);
    expect(s).toMatchObject({ action: "comments_search", query: "hi" });
    const art = parseBiliRequest(new URL("https://www.bilibili.com/read/cv123?bili=article"), config);
    expect(art.ref.cv).toBe("123");
  });

  it("非法动作抛 BILI_INVALID_URL", () => {
    for (const u of [
      "https://www.bilibili.com/video/BV1xx411c7mD?bili=nope",
      "https://www.bilibili.com/video/BV1xx411c7mD?bili=comments_search",
      "https://www.bilibili.com/read/cv123?bili=detail",
    ]) {
      expect(() => parseBiliRequest(new URL(u), config)).toThrow(BiliError);
    }
  });
});

describe("plugin", () => {
  it("只接管带 bili 参数的 B 站地址", () => {
    expect(bilibiliPlugin.match(new URL("https://www.bilibili.com/video/BV1xx411c7mD"))).toBe(false);
    expect(bilibiliPlugin.match(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=detail"))).toBe(true);
  });

  it("enabled=false 明确报不可用", async () => {
    const config = cfg("gateway: { host: 127.0.0.1 }\nbilibili: { enabled: false }\n");
    const r = await bilibiliPlugin.fetch(new URL("https://www.bilibili.com/video/BV1xx411c7mD?bili=video"), { config });
    expect(r).toMatchObject({ ok: false, errorCode: "BILI_UNAVAILABLE" });
  });
});

describe("comment store", () => {
  it("落库、展开楼中楼、检索、断点", () => {
    const d = mkdtempSync(join(tmpdir(), "bili-store-"));
    dirs.push(d);
    const store = createCommentStore(join(d, "c.sqlite"));
    const items: BiliComment[] = [
      { rpid: 1, mid: 10, uname: "a", content: "hello 世界", like: 7, ctime: 1, replies: [
        { rpid: 2, root: 1, parent: 1, mid: 11, uname: "b", content: "reply", like: 1, ctime: 2 },
      ] },
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

describe("download", () => {
  const serve = (handler: Parameters<typeof createServer>[1]): Promise<string> =>
    new Promise((resolve) => {
      const s = createServer(handler);
      servers.push(s);
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/m`);
      });
    });

  it("正常下载", async () => {
    const url = await serve((_q, r) => { r.writeHead(200, { "content-type": "video/mp4" }); r.end("hi"); });
    const got = await downloadStream({ url, contentType: "video/mp4" }, localCfg());
    expect(got.bytes.toString()).toBe("hi");
  });

  it("412 → BILI_RISK_CONTROL", async () => {
    const url = await serve((_q, r) => { r.writeHead(412); r.end(); });
    await expect(downloadStream({ url, contentType: "video/mp4" }, localCfg())).rejects.toMatchObject({ code: "BILI_RISK_CONTROL" });
  });

  it("超限中止", async () => {
    const url = await serve((_q, r) => { r.writeHead(200); r.end(Buffer.alloc(4096)); });
    await expect(downloadStream({ url, contentType: "video/mp4" }, localCfg(64))).rejects.toMatchObject({ code: "BILI_DOWNLOAD_FAIL" });
  });

  it("白名单外拒绝", async () => {
    await expect(downloadStream({ url: "https://example.com/a", contentType: "video/mp4" }, localCfg())).rejects.toMatchObject({ code: "BILI_INVALID_URL" });
  });
});

it("audio/mp4 → .m4a", () => {
  expect(extForContentType("audio/mp4")).toBe(".m4a");
});
