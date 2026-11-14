import { describe, expect, it } from "vitest";
import { bilibiliPlugin } from "../src/bilibili/index.js";
import { cnkiPlugin } from "../src/fetch/plugins/cnki.js";
import { runCliProcess } from "../src/fetch/channels/cli.js";
import { CHANNELS, normalizeChannel } from "../src/fetch/channels/registry.js";
import { weiboPlugin } from "../src/weibo/index.js";

describe("通道规范化", () => {
  it("别名与规范 ID 都能归一化", () => {
    expect(normalizeChannel("bili")?.id).toBe("bilibili:kukemc");
    expect(normalizeChannel("bilibili:kukemc")?.id).toBe("bilibili:kukemc");
    expect(normalizeChannel("bilibili:ytdlp")?.id).toBe("bilibili:ytdlp");
    expect(normalizeChannel("ytdlp")?.id).toBe("bilibili:ytdlp");
    expect(normalizeChannel("article")?.id).toBe("bilibili:article");
    expect(normalizeChannel("bilibili:http")?.id).toBe("bilibili:article");
    expect(normalizeChannel("opencli")?.id).toBe("weibo:opencli");
    expect(normalizeChannel("weibo")?.id).toBe("weibo:opencli");
    expect(normalizeChannel("weibo:opencli")?.id).toBe("weibo:opencli");
    expect(normalizeChannel("cnki")?.id).toBe("cnki:http");
    expect(normalizeChannel(" CNKI:HTTP ")?.id).toBe("cnki:http");
  });

  it("未知输入返回 undefined（不做模糊纠错）", () => {
    expect(normalizeChannel("bilibli")).toBeUndefined();
    expect(normalizeChannel("bilibili:nope")).toBeUndefined();
    expect(normalizeChannel("")).toBeUndefined();
  });

  it("CHANNELS 的 id 唯一", () => {
    const ids = CHANNELS.map((channel) => channel.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "bilibili:kukemc",
      "bilibili:ytdlp",
      "bilibili:article",
      "weibo:opencli",
      "cnki:http",
    ]);
  });

  it("三个插件的 channels 与注册表一致", () => {
    expect(bilibiliPlugin.channels?.map((channel) => channel.id)).toEqual([
      "bilibili:kukemc",
      "bilibili:ytdlp",
      "bilibili:article",
    ]);
    expect(weiboPlugin.channels?.map((channel) => channel.id)).toEqual(["weibo:opencli"]);
    expect(cnkiPlugin.channels?.map((channel) => channel.id)).toEqual(["cnki:http"]);
  });
});

describe("runCliProcess", () => {
  it("成功命令返回 stdout", async () => {
    const result = await runCliProcess(process.execPath, ["-e", "console.log('ok')"], {
      timeoutMs: 5000,
    });
    expect(result.failed).toBe(false);
    // 与旧实现一致：成功时 err 为 null，exitCode 为 null（业务层只在 failed 时读它）。
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeUndefined();
    expect(result.stdout.trim()).toBe("ok");
  });

  it("命令不存在返回 ENOENT", async () => {
    const result = await runCliProcess("asg-definitely-not-a-command", [], { timeoutMs: 5000 });
    expect(result.failed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBe("ENOENT");
  });

  it("超时标记 timedOut", async () => {
    const result = await runCliProcess(
      process.execPath,
      ["-e", "setTimeout(() => {}, 1000)"],
      { timeoutMs: 50 },
    );
    expect(result.failed).toBe(true);
    expect(result.timedOut).toBe(true);
  });
});
