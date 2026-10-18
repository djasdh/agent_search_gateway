import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectImageMime,
  extractPublishedUrl,
  loadLocalImage,
  publishImage,
  type LocalImage,
} from "../src/search/image-publish.js";

/** 最小合法图片头（≥12 字节，detectImageMime 要求）。 */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(64, 0x7f),
]);

describe("detectImageMime", () => {
  it("按 magic bytes 识别图片类型", () => {
    expect(detectImageMime(JPEG)).toBe("image/jpeg");
    expect(detectImageMime(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]))).toBe("image/png");
    expect(detectImageMime(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]))).toBe("image/gif");
    expect(detectImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]))).toBe("image/webp");
    expect(detectImageMime(Buffer.concat([Buffer.from("BM"), Buffer.alloc(10)]))).toBe("image/bmp");
  });

  it("非图片 / 过短 → undefined（这是防止误传本地文件的第一道闸）", () => {
    expect(detectImageMime(Buffer.from("root:x:0:0:root:/root:/bin/bash"))).toBeUndefined();
    expect(detectImageMime(Buffer.from("{\"apiKey\":\"secret\"}"))).toBeUndefined();
    expect(detectImageMime(Buffer.from([0xff, 0xd8]))).toBeUndefined();
    expect(detectImageMime(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("extractPublishedUrl（uguu/pomf 响应）", () => {
  it("取 files[0].url", () => {
    expect(
      extractPublishedUrl({
        success: true,
        files: [{ hash: "0432f462a5d88af2", filename: "PKgpFWGz.jpg", url: "https://n.uguu.se/PKgpFWGz.jpg", size: 8367, dupe: false }],
      }),
    ).toEqual({ url: "https://n.uguu.se/PKgpFWGz.jpg" });
  });

  it("success=false / 带 error / 无 files / 非 http → 取不到并带回原因", () => {
    expect(extractPublishedUrl({ success: false }).error).toContain("success=false");
    expect(extractPublishedUrl({ error: "File too large" })).toEqual({ error: "File too large" });
    expect(extractPublishedUrl({ success: true }).url).toBeUndefined();
    expect(extractPublishedUrl({ success: true, files: [{ url: "ftp://x/y.jpg" }] }).url).toBeUndefined();
    expect(extractPublishedUrl(null).url).toBeUndefined();
  });
});

describe("loadLocalImage（三重校验）", () => {
  let dir = "";
  const img = () => join(dir, "pic.jpg");
  const txt = () => join(dir, "notes.txt");
  const big = () => join(dir, "big.jpg");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgpub-"));
    await writeFile(img(), JPEG);
    await writeFile(txt(), "这不是图片，是私密配置\n");
    await writeFile(big(), Buffer.concat([JPEG, Buffer.alloc(4096)]));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("合法图片：返回 mime/大小/文件名", async () => {
    const r = await loadLocalImage(img(), 1024 * 1024);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.mime).toBe("image/jpeg");
      expect(r.image.filename).toBe("pic.jpg");
      expect(r.image.size).toBe(JPEG.byteLength);
    }
  });

  it("不存在 → not_found；目录 → not_file", async () => {
    const missing = await loadLocalImage(join(dir, "nope.jpg"), 1024);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe("not_found");

    const d = await loadLocalImage(dir, 1024);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.kind).toBe("not_file");
  });

  it("超过上限 → too_large（读之前就挡）", async () => {
    const r = await loadLocalImage(big(), 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("too_large");
  });

  it("非图片（文本/配置）→ not_image", async () => {
    const r = await loadLocalImage(txt(), 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("not_image");
  });
});

describe("publishImage（uguu/pomf 协议）", () => {
  let server: ReturnType<typeof createHttpServer>;
  let port = 0;
  let mode: "ok" | "http500" | "notjson" | "apifail" | "slow" = "ok";
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
      lastContentType = String(req.headers["content-type"] ?? "");
      lastBody = await readBody(req);
      if (mode === "slow") {
        await new Promise((r) => setTimeout(r, 1200));
      }
      res.setHeader("Content-Type", "application/json");
      if (mode === "http500") {
        res.statusCode = 500;
        res.end("nope");
        return;
      }
      if (mode === "notjson") {
        res.end("<html>not json</html>");
        return;
      }
      if (mode === "apifail") {
        res.end(JSON.stringify({ success: false, error: "File too large" }));
        return;
      }
      res.end(
        JSON.stringify({ success: true, files: [{ filename: "abc.jpg", url: "https://n.uguu.se/abc.jpg", size: JPEG.byteLength }] }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  const image: LocalImage = { path: "/tmp/pic.jpg", filename: "pic.jpg", mime: "image/jpeg", size: JPEG.byteLength, bytes: JPEG };
  const endpoint = () => `http://127.0.0.1:${port}/upload?output=json`;

  it("成功：multipart 带 files[] 字段与原始字节，返回 url", async () => {
    mode = "ok";
    const r = await publishImage(endpoint(), 5000, image);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://n.uguu.se/abc.jpg");
    expect(lastContentType).toContain("multipart/form-data; boundary=");
    expect(lastBody).toContain('name="files[]"');
    expect(lastBody).toContain('filename="pic.jpg"');
    expect(lastBody).toContain("Content-Type: image/jpeg");
    expect(lastBody).toContain(JPEG.toString("latin1")); // 字节原样送达
  });

  it("HTTP 500 → kind=http；非 JSON → invalid_json；success=false → api（带原因）", async () => {
    mode = "http500";
    const a = await publishImage(endpoint(), 5000, image);
    expect(!a.ok && a.error.kind).toBe("http");

    mode = "notjson";
    const b = await publishImage(endpoint(), 5000, image);
    expect(!b.ok && b.error.kind).toBe("invalid_json");

    mode = "apifail";
    const c = await publishImage(endpoint(), 5000, image);
    expect(!c.ok && c.error.kind).toBe("api");
    if (!c.ok) expect(c.error.message).toContain("File too large");
  });

  it("超时 → kind=timeout（不抛异常）", async () => {
    mode = "slow";
    const r = await publishImage(endpoint(), 200, image);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("timeout");
    mode = "ok";
  });

  it("不可达 → kind=network", async () => {
    const r = await publishImage("http://127.0.0.1:1/upload", 1000, image);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["network", "timeout"]).toContain(r.error.kind);
  });
});
