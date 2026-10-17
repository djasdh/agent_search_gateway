import { describe, expect, it } from "vitest";
import type { CleanedResult } from "../src/search/clean.js";
import { renderResults, renderSearchMarkdown } from "../src/search/render.js";
import type { SearxngResponse } from "../src/search/searxng.js";

function web(overrides: Partial<CleanedResult> = {}): CleanedResult {
  return {
    title: "Web Title",
    url: "https://page.example/a",
    content: "web content",
    engines: ["ddg"],
    score: 0.9,
    ...overrides,
  };
}

function image(overrides: Partial<CleanedResult> = {}): CleanedResult {
  return {
    title: "Cat Photo",
    url: "https://page.example/photo",
    content: "",
    engines: ["bing images"],
    category: "images",
    imgSrc: "https://img.example/cat.jpg",
    score: 3,
    ...overrides,
  };
}

const emptyRaw: SearxngResponse = { results: [] };

describe("renderResults 图片结果", () => {
  it("图片结果输出 markdown 图片 + 来源页 + 尺寸/格式/引擎", () => {
    const text = renderResults([
      image({ resolution: "1920 x 1080", imgFormat: "jpg", imgSource: "Example" }),
    ]);
    expect(text).toContain("1. ![Cat Photo](https://img.example/cat.jpg)");
    expect(text).toContain("[来源页](https://page.example/photo)");
    expect(text).toContain("1920 x 1080");
    expect(text).toContain("jpg");
    expect(text).toContain("Example");
    expect(text).toContain("bing images");
    expect(text).toContain("score 3.00");
  });

  it("只有缩略图时标注「缩略图」并沿用缩略图直链", () => {
    const text = renderResults([
      image({ imgSrc: undefined, thumbnailSrc: "https://img.example/thumb.jpg" }),
    ]);
    expect(text).toContain("![Cat Photo](https://img.example/thumb.jpg)");
    expect(text).toContain("缩略图");
  });

  it("无标题的图片结果题注回退为「图片」", () => {
    const text = renderResults([image({ title: "" })]);
    expect(text).toContain("![图片](https://img.example/cat.jpg)");
  });

  it("标题里的方括号被转义，不破坏链接语法", () => {
    const text = renderResults([image({ title: "a [b] c" })]);
    expect(text).toContain("![a \\[b\\] c](https://img.example/cat.jpg)");
  });

  it("仅有 category=images 但无直链时退回网页渲染", () => {
    const text = renderResults([image({ imgSrc: undefined, thumbnailSrc: undefined })]);
    expect(text).not.toContain("![");
    expect(text).toContain("[Cat Photo](https://page.example/photo)");
  });

  it("网页结果渲染不受影响", () => {
    const text = renderResults([web()]);
    expect(text).toBe("1. [Web Title](https://page.example/a) · ddg · score 0.90\n   web content");
  });
});

describe("renderSearchMarkdown", () => {
  it("图片结果混排时可整篇渲染", () => {
    const text = renderSearchMarkdown({
      query: "cat",
      raw: emptyRaw,
      results: [image(), web()],
      latencyMs: 42,
    });
    expect(text).toContain("# Search: cat");
    expect(text).toContain("2 个结果");
    expect(text).toContain("![Cat Photo](https://img.example/cat.jpg)");
    expect(text).toContain("[Web Title](https://page.example/a)");
  });

  it("无结果时给出建议文案", () => {
    const text = renderSearchMarkdown({ query: "nope", raw: emptyRaw, results: [], latencyMs: 1 });
    expect(text).toContain("*没有找到结果。*");
  });
});
