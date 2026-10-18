import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saucenaoToResults, searchSaucenao, type SaucenaoResponse } from "../src/search/saucenao.js";

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(32, 0x33),
]);

function resp(results: unknown[], header: Record<string, unknown> = { status: 0 }): SaucenaoResponse {
  return { header, results: results as SaucenaoResponse["results"] };
}

describe("saucenaoToResults", () => {
  it("按相似度降序，且丢掉低于 minsim 的", () => {
    const r = saucenaoToResults(
      resp([
        { header: { similarity: "70.0", thumbnail: "https://t/1.jpg", index_name: "Pixiv" }, data: { pixiv_id: 111, title: "A" } },
        { header: { similarity: "95.5", thumbnail: "https://t/2.jpg", index_name: "Danbooru" }, data: { ext_urls: ["https://d/2"], title: "B" } },
        { header: { similarity: "10.0", thumbnail: "https://t/3.jpg" }, data: { title: "C" } },
      ]),
      8,
      30,
    );
    expect(r.map((x) => x.title)).toEqual(["B", "A"]);
    expect(r[0]!.score).toBeCloseTo(0.955);
    expect(r[0]!.engine).toBe("saucenao");
    expect(r[0]!.url).toBe("https://d/2");
    expect(r[0]!.img_src).toBe("https://t/2.jpg");
  });

  it("pixiv_id → pixiv 作品页；ext_urls 兜底；仅有缩略图也能出条目", () => {
    const r = saucenaoToResults(
      resp([
        { header: { similarity: 90, thumbnail: "https://t/a.jpg" }, data: { pixiv_id: "42", title: "pixiv 图" } },
        { header: { similarity: 80, thumbnail: "https://t/b.jpg" }, data: { ext_urls: ["https://ext/1", "https://ext/2"], title: "ext 图" } },
        { header: { similarity: 70, thumbnail: "https://t/c.jpg" }, data: { title: "只有缩略图" } },
      ]),
      8,
      0,
    );
    expect(r.find((x) => x.title === "pixiv 图")!.url).toBe("https://www.pixiv.net/artworks/42");
    expect(r.find((x) => x.title === "ext 图")!.url).toBe("https://ext/1");
    expect(r.find((x) => x.title === "只有缩略图")!.url).toBe("https://t/c.jpg");
  });

  it("标题优先级 title→material；作者数组 join；无 url/缩略图则丢弃", () => {
    const r = saucenaoToResults(
      resp([
        { header: { similarity: 90, thumbnail: "https://t/1.jpg" }, data: { material: "材质名", author: ["甲", "乙"] } },
        { header: { similarity: 80 }, data: { jp_name: "无图", title: "无图" } },
        { header: { similarity: 70, thumbnail: "https://t/3.jpg" }, data: { title: "正常" } },
      ]),
      8,
      0,
    );
    expect(r).toHaveLength(2);
    expect(r[0]!.title).toBe("材质名");
    expect(r[0]!.content).toContain("作者 甲, 乙");
  });

  it("相似度非数字 / 缺结果 → 丢弃或空数组", () => {
    expect(saucenaoToResults(resp([{ data: { title: "x" } }]), 8, 0)).toEqual([]);
    expect(saucenaoToResults({}, 8, 0)).toEqual([]);
  });

  it("maxResults 截断", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      header: { similarity: 90 - i, thumbnail: `https://t/${i}.jpg` },
      data: { title: `t${i}` },
    }));
    expect(saucenaoToResults(resp(many), 2, 0)).toHaveLength(2);
  });
});

// ── 客户端（mock 服务器）──

let server: ReturnType<typeof createHttpServer>;
let port = 0;
let mode: "ok" | "anon" | "http500" | "notjson" = "ok";
let lastMethod = "";
let lastUrl = "";
let lastBody = "";
let lastContentType = "";

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });

beforeAll(async () => {
  server = createHttpServer(async (req, res) => {
    lastMethod = req.method ?? "";
    lastUrl = req.url ?? "";
    lastContentType = String(req.headers["content-type"] ?? "");
    lastBody = await readBody(req);
    if (mode === "http500") {
      res.statusCode = 500;
      res.end("boom");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (mode === "notjson") {
      res.end("<html>nope</html>");
      return;
    }
    if (mode === "anon") {
      res.end(JSON.stringify({ header: { status: -1, message: "The anonymous account type does not permit API usage." } }));
      return;
    }
    res.end(
      JSON.stringify({
        header: { status: 0, short_remaining: 3, long_remaining: 148 },
        results: [
          { header: { similarity: "91.0", thumbnail: "https://t/x.jpg", index_name: "Pixiv" }, data: { pixiv_id: 7, title: "样例" } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const opts = () => ({
  apiKey: "test-key",
  timeoutMs: 3000,
  maxResults: 5,
  minsim: 0,
  baseUrl: `http://127.0.0.1:${port}`,
});

describe("searchSaucenao（mock）", () => {
  it("URL 输入：POST + url 参数 + output_type/db/api_key；解析结果与剩余额度", async () => {
    mode = "ok";
    const r = await searchSaucenao(opts(), { kind: "url", url: "https://img.example/example.jpg" });
    expect(lastMethod).toBe("POST");
    expect(lastUrl).toContain("/search.php?");
    expect(lastUrl).toContain("output_type=2");
    expect(lastUrl).toContain("db=999");
    expect(lastUrl).toContain("api_key=test-key");
    expect(decodeURIComponent(lastUrl)).toContain("url=https://img.example/example.jpg");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results).toHaveLength(1);
      expect(r.results[0]!.engine).toBe("saucenao");
      expect(r.remaining).toEqual({ short: 3, long: 148 });
    }
  });

  it("本地字节：multipart 字段 file，字节原样送达", async () => {
    mode = "ok";
    const r = await searchSaucenao(opts(), { kind: "bytes", bytes: JPEG, filename: "shot.jpg", mime: "image/jpeg" });
    expect(lastContentType).toContain("multipart/form-data; boundary=");
    expect(lastBody).toContain('name="file"');
    expect(lastBody).toContain('filename="shot.jpg"');
    expect(lastBody).toContain(JPEG.toString("latin1"));
    expect(r.ok).toBe(true);
  });

  it("匿名 key / status<0 → api 错误（带 message）", async () => {
    mode = "anon";
    const r = await searchSaucenao(opts(), { kind: "url", url: "https://img.example/x.jpg" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("api");
      expect(r.error.message).toContain("anonymous");
    }
  });

  it("HTTP 500 → http；非 JSON → invalid_json", async () => {
    mode = "http500";
    const a = await searchSaucenao(opts(), { kind: "url", url: "https://img.example/x.jpg" });
    expect(!a.ok && a.error.kind).toBe("http");
    mode = "notjson";
    const b = await searchSaucenao(opts(), { kind: "url", url: "https://img.example/x.jpg" });
    expect(!b.ok && b.error.kind).toBe("invalid_json");
  });

  it("不可达 → network（不抛异常）", async () => {
    const r = await searchSaucenao({ ...opts(), baseUrl: "http://127.0.0.1:1" }, { kind: "url", url: "https://img.example/x.jpg" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["network", "timeout"]).toContain(r.error.kind);
  });
});
