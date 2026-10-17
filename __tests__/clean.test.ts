import { describe, expect, it } from "vitest";
import { cleanResults } from "../src/search/clean.js";

function r(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/page",
    title: "Example Title",
    content: "Some content",
    engine: "ddg",
    engines: ["ddg"],
    ...overrides,
  };
}

describe("cleanResults", () => {
  it("过滤空 title/url 和非法协议", () => {
    const out = cleanResults(
      [
        r(),
        r({ title: "" }),
        r({ url: "" }),
        r({ url: "javascript:alert(1)" }),
      ],
      {},
    );
    expect(out.results).toHaveLength(1);
  });

  it("按规范化 URL 去重（剥 utm_*）", () => {
    const out = cleanResults(
      [
        r({ url: "https://example.com/a?utm_source=x" }),
        r({ url: "https://example.com/a" }),
        r({ url: "https://example.com/b" }),
      ],
      {},
    );
    expect(out.results).toHaveLength(2);
  });

  it("解码 HTML 实体并压缩空白、截断 content", () => {
    const out = cleanResults([r({ content: "a &amp; b   <script>x</script>" })], { maxResultChars: 5 });
    expect(out.results[0].content.startsWith("a & b")).toBe(true);
    expect(out.results[0].content.endsWith("…")).toBe(true);
    expect(out.results[0].content.length).toBeLessThanOrEqual(6);
  });

  it("min_score 过滤", () => {
    const out = cleanResults([r({ score: 0.8 }), r({ score: 0.3 })], { minScore: 0.5 });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].score).toBe(0.8);
  });

  it("不再切片：返回全部清洗后候选（切片由服务层负责）", () => {
    const items = Array.from({ length: 10 }, (_, i) => r({ url: `https://e.com/${i}` }));
    const out = cleanResults(items, {});
    expect(out.results).toHaveLength(10);
  });

  it("shouldBlock 丢弃命中黑名单域名", () => {
    const block = (h: string) => h.endsWith("spam.com");
    const out = cleanResults(
      [r({ url: "https://spam.com/x" }), r({ url: "https://good.com/y" })],
      { shouldBlock: block },
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0].url).toContain("good.com");
  });

  it("engines 合并：单引擎转数组", () => {
    const out = cleanResults([r({ engine: "google", engines: undefined })], {});
    expect(out.results[0].engines).toEqual(["google"]);
  });

  it("图片字段透传（img_src/thumbnail_src/resolution/img_format/source）", () => {
    const out = cleanResults(
      [
        r({
          url: "https://page.example/photo",
          title: "Photo",
          content: "",
          category: "images",
          img_src: "https://img.example/a.jpg",
          thumbnail_src: "https://img.example/a-thumb.jpg",
          resolution: "1920 x 1080",
          img_format: "jpg",
          source: "Example",
        }),
      ],
      {},
    );
    expect(out.results).toHaveLength(1);
    const [item] = out.results;
    expect(item.imgSrc).toBe("https://img.example/a.jpg");
    expect(item.thumbnailSrc).toBe("https://img.example/a-thumb.jpg");
    expect(item.resolution).toBe("1920 x 1080");
    expect(item.imgFormat).toBe("jpg");
    expect(item.imgSource).toBe("Example");
  });

  it("图片结果无标题仍保留（有直链即可用）；网页结果无标题仍丢弃", () => {
    const out = cleanResults(
      [
        r({ url: "https://page.example/a", title: "", img_src: "https://img.example/a.jpg" }),
        r({ url: "https://page.example/b", title: "" }),
      ],
      {},
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0].url).toBe("https://page.example/a");
    expect(out.results[0].title).toBe("");
  });

  it("非字符串的图片字段按缺失处理", () => {
    const out = cleanResults([r({ img_src: 123, thumbnail_src: null, resolution: {} })], {});
    expect(out.results[0].imgSrc).toBeUndefined();
    expect(out.results[0].thumbnailSrc).toBeUndefined();
    expect(out.results[0].resolution).toBeUndefined();
  });
});
