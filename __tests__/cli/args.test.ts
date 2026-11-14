import { describe, expect, it } from "vitest";
import { parseInvocation, takeFlag, takeValue } from "../../src/cli/args.js";

describe("CLI 参数解析", () => {
  it("命令之后的 --version 留给子命令", () => {
    const args = parseInvocation(["update", "apply", "--version", "0.3.0"]);
    expect(args.globals.version).toBe(false);
    expect(args.command).toBe("update");
    expect(args.rest).toEqual(["apply", "--version", "0.3.0"]);
  });

  it("命令之前的 --version 是全局选项", () => {
    const args = parseInvocation(["--version"]);
    expect(args.globals.version).toBe(true);
    expect(args.command).toBeUndefined();
  });

  it("--json/--root 可出现在命令之后", () => {
    const args = parseInvocation(["status", "--json", "--root", "/tmp/asg"]);
    expect(args.globals.json).toBe(true);
    expect(args.globals.root).toBe("/tmp/asg");
    expect(args.command).toBe("status");
    expect(args.rest).toEqual([]);
  });

  it("takeValue 支持空格与等号写法", () => {
    const spaced = ["--level", "full"];
    expect(takeValue(spaced, "--level")).toBe("full");
    expect(spaced).toEqual([]);

    const equals = ["--level=ads"];
    expect(takeValue(equals, "--level")).toBe("ads");
    expect(equals).toEqual([]);
  });

  it("takeFlag 支持别名并移除参数", () => {
    const rest = ["gateway", "-f"];
    expect(takeFlag(rest, "-f", "--follow")).toBe(true);
    expect(rest).toEqual(["gateway"]);
  });

  it("--json 与 --jsonl 互斥", () => {
    expect(() => parseInvocation(["status", "--json", "--jsonl"])).toThrow(/不能同时使用/);
  });
});
