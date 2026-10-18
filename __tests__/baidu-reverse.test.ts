import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  baiduToResults,
  extractBaiduCardData,
  searchBaiduReverse,
  type BaiduCard,
} from "../src/search/baidu-reverse.js";

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(64, 0x5a),
]);

describe("extractBaiduCardData", () => {
  it("从结果页 HTML 里抠出 window.cardData", () => {
    const html = `<html><script>window.cardData = [{"cardName":"same","tplData":{"list":[{"url":"https://u","image_src":"https://i"}]}}];</script></html>`;
    const cards = extractBaiduCardData(html);
    expect(cards).toHaveLength(1);
    expect(cards![0]!.cardName).toBe("same");
  });

  it("找不到 / 非法 JSON → undefined", () => {
    expect(extractBaiduCardData("<html>nothing here</html>")).toBeUndefined();
    expect(extractBaiduCardData("window.cardData = [{bad json}];")).toBeUndefined();
  });
});

describe("baiduToResults", () => {
  const cards: BaiduCard[] = [
    { cardName: "same", tplData: { list: [{ url: "https://duitang/1", image_src: "https://img/1.jpg" }] } },
    { cardName: "simipic", tplData: { firstUrl: "https://x/ajax" } },
  ];

  it("same + simipic 详情合并；分辨率从 width/height", () => {
    const detail = { data: { list: [{ thumbUrl: "https://img/2.jpg", fromUrl: "https://bilibili/2", width: 1409, height: 881 }] } };
    const r = baiduToResults(cards, detail, 8);
    expect(r).toHaveLength(2);
    expect(r[0]!.engine).toBe("baidu");
    expect(r[0]!.url).toBe("https://duitang/1");
    expect(r[0]!.img_src).toBe("https://img/1.jpg");
    expect(r[1]!.resolution).toBe("1409 x 881");
    expect(r[1]!.url).toBe("https://bilibili/2");
    expect(r[1]!.img_src).toBe("https://img/2.jpg");
  });

  it("空 cardData / 无详情 → []", () => {
    expect(baiduToResults([], undefined, 8)).toEqual([]);
  });

  it("maxResults 截断", () => {
    const d = {
      data: { list: Array.from({ length: 5 }, (_, i) => ({ thumbUrl: `https://i/${i}.jpg`, fromUrl: `https://f/${i}` })) },
    };
    expect(baiduToResults([], d, 3)).toHaveLength(3);
  });
});

// ── 客户端（mock 三步）──

let server: ReturnType<typeof createHttpServer>;
let port = 0;
let mode: "ok" | "reject" | "noresult" | "structchange" = "ok";
let lastUploadBody = "";

beforeAll(async () => {
  server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "POST" && url.pathname === "/upload") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      lastUploadBody = Buffer.concat(chunks).toString("latin1");
      res.setHeader("Content-Type", "application/json");
      if (mode === "reject") {
        res.end(JSON.stringify({ status: 1, msg: "Reject", data: null }));
        return;
      }
      res.end(JSON.stringify({ status: 0, msg: "Success", data: { url: `http://127.0.0.1:${port}/s?sign=abc` } }));
      return;
    }
    if (url.pathname === "/s") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (mode === "noresult") {
        res.end('<script>window.cardData = [{"cardName":"noresult","tplData":{}}];</script>');
        return;
      }
      if (mode === "structchange") {
        res.end("<html>changed</html>");
        return;
      }
      res.end(
        '<script>window.cardData = [{"cardName":"same","tplData":{"list":[{"url":"https://duitang/1","image_src":"https://img/1.jpg"}]}},' +
          '{"cardName":"simipic","tplData":{"firstUrl":"http://127.0.0.1:' +
          port +
          '/ajax/pcsimi?x=1"}}];</script>',
      );
      return;
    }
    if (url.pathname === "/ajax/pcsimi") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          status: 0,
          data: { list: [{ thumbUrl: "https://img/2.jpg", fromUrl: "https://bilibili/2", width: 1409, height: 881 }] },
        }),
      );
      return;
    }
    if (url.pathname === "/img.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      res.end(JPEG);
      return;
    }
    res.statusCode = 404;
    res.end("nf");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const opts = () => ({ timeoutMs: 3000, maxResults: 8, maxBytes: 5 * 1024 * 1024, baseUrl: `http://127.0.0.1:${port}` });

describe("searchBaiduReverse（mock 三步）", () => {
  it("本地字节：upload（字段 image）→ 结果页 → 相似图详情", async () => {
    mode = "ok";
    const r = await searchBaiduReverse(opts(), { kind: "bytes", bytes: JPEG, filename: "shot.jpg", mime: "image/jpeg" });
    expect(lastUploadBody).toContain('name="image"');
    expect(lastUploadBody).toContain('name="from"');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results).toHaveLength(2);
      expect(r.results[0]!.engine).toBe("baidu");
      expect(r.results[1]!.resolution).toBe("1409 x 881");
    }
  });

  it("URL 输入：先下载再上传", async () => {
    mode = "ok";
    const r = await searchBaiduReverse(opts(), { kind: "url", url: `http://127.0.0.1:${port}/img.jpg` });
    expect(r.ok).toBe(true);
    expect(lastUploadBody).toContain(JPEG.toString("latin1"));
  });

  it("upload 被拒（Reject）→ api 错误", async () => {
    mode = "reject";
    const r = await searchBaiduReverse(opts(), { kind: "bytes", bytes: JPEG, filename: "x.jpg", mime: "image/jpeg" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("api");
      expect(r.error.message).toContain("Reject");
    }
  });

  it("noresult → 空结果（不算错）", async () => {
    mode = "noresult";
    const r = await searchBaiduReverse(opts(), { kind: "bytes", bytes: JPEG, filename: "x.jpg", mime: "image/jpeg" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results).toEqual([]);
  });

  it("结果页没有 cardData（改版）→ api 错误", async () => {
    mode = "structchange";
    const r = await searchBaiduReverse(opts(), { kind: "bytes", bytes: JPEG, filename: "x.jpg", mime: "image/jpeg" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("api");
  });

  it("URL 输入超过大小上限 → 错误（不上传）", async () => {
    mode = "ok";
    const r = await searchBaiduReverse({ ...opts(), maxBytes: 4 }, { kind: "url", url: `http://127.0.0.1:${port}/img.jpg` });
    expect(r.ok).toBe(false);
  });
});
