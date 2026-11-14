import { describe, expect, it } from "vitest";
import {
  canonicalChannelId,
  normalizePlatform,
  platformInfo,
  PLATFORMS,
} from "../src/fetch/platforms.js";

describe("平台规范化", () => {
  it("规范 ID 与别名都能归一化", () => {
    expect(normalizePlatform("bilibili")).toBe("bilibili");
    expect(normalizePlatform("bili")).toBe("bilibili");
    expect(normalizePlatform(" B站 ")).toBe("bilibili");
    expect(normalizePlatform("哔哩哔哩")).toBe("bilibili");
    expect(normalizePlatform("weibo")).toBe("weibo");
    expect(normalizePlatform("微博")).toBe("weibo");
    expect(normalizePlatform("cnki")).toBe("cnki");
    expect(normalizePlatform("知网")).toBe("cnki");
  });

  it("未知输入返回 undefined（不做模糊纠错）", () => {
    expect(normalizePlatform("bilibli")).toBeUndefined();
    expect(normalizePlatform("")).toBeUndefined();
    expect(normalizePlatform("tieba")).toBeUndefined();
  });

  it("platformInfo 支持 ID 与别名", () => {
    expect(platformInfo("bili")).toMatchObject({ id: "bilibili", displayName: "Bilibili" });
    expect(platformInfo("微博")?.id).toBe("weibo");
    expect(platformInfo("nope")).toBeUndefined();
    expect(PLATFORMS.map((p) => p.id)).toEqual(["bilibili", "weibo", "cnki"]);
  });

  it("通道 ID 统一为 platform:channel", () => {
    expect(canonicalChannelId("bilibili", "kukemc")).toBe("bilibili:kukemc");
    expect(canonicalChannelId("bili", " kukemc ")).toBe("bilibili:kukemc");
    expect(canonicalChannelId("weibo", "opencli")).toBe("weibo:opencli");
  });
});
