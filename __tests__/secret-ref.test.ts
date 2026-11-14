import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSecretTree, resolveSecretValue } from "../src/settings/secret-ref.js";
import { loadSettingsFrom } from "../src/settings/load.js";
import { getSecretAtPath, defaultSecrets } from "../src/settings/secrets.js";

describe("resolveSecretValue", () => {
  it("env:NAME 从传入 env 读取", () => {
    expect(resolveSecretValue("env:FOO", { FOO: "bar" })).toBe("bar");
    expect(resolveSecretValue("  env:FOO  ", { FOO: "bar" })).toBe("bar");
  });

  it("缺失环境变量返回空串", () => {
    expect(resolveSecretValue("env:MISSING", {})).toBe("");
    expect(resolveSecretValue("env:", { FOO: "bar" })).toBe("");
  });

  it("明文原样返回（兼容保留）", () => {
    expect(resolveSecretValue("plain-token", { FOO: "bar" })).toBe("plain-token");
    expect(resolveSecretValue("  spaced  ", {})).toBe("  spaced  ");
  });
});

describe("resolveSecretTree", () => {
  it("递归处理对象与数组中的字符串", () => {
    const input = {
      a: "env:A",
      nested: { b: "env:B", list: ["env:A", "literal"] },
      n: 1,
      flag: true,
    };
    expect(resolveSecretTree(input, { A: "a-value", B: "b-value" })).toEqual({
      a: "a-value",
      nested: { b: "b-value", list: ["a-value", "literal"] },
      n: 1,
      flag: true,
    });
  });
});

describe("secrets 加载与读取", () => {
  it("loadSettingsFrom 把 secrets.yaml 的 env: 解析成实际值", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-ref-"));
    try {
      const configPath = join(dir, "gateway.yaml");
      const secretsPath = join(dir, "secrets.yaml");
      writeFileSync(configPath, "gateway: { host: 127.0.0.1 }\n");
      writeFileSync(secretsPath, "bilibili:\n  http:\n    token: env:MY_BILI_TOKEN\n");

      const { secrets } = loadSettingsFrom(configPath, secretsPath, { MY_BILI_TOKEN: "real-token" });
      expect(secrets.bilibili.http.token).toBe("real-token");

      const missing = loadSettingsFrom(configPath, secretsPath, {});
      expect(missing.secrets.bilibili.http.token).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getSecretAtPath 支持带/不带 secrets. 前缀", () => {
    const secrets = defaultSecrets();
    secrets.bilibili.http.token = "tok";
    expect(getSecretAtPath(secrets, "secrets.bilibili.http.token")).toBe("tok");
    expect(getSecretAtPath(secrets, "bilibili.http.token")).toBe("tok");
    expect(getSecretAtPath(secrets, "weibo.cli.command")).toBeUndefined();
    expect(getSecretAtPath(secrets, "bilibili.http")).toBeUndefined();
    expect(getSecretAtPath(secrets, "secrets")).toBeUndefined();
  });
});
