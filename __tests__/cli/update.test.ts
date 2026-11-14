import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Reporter } from "../../src/cli/output.js";
import { runUpdate, updateArgs } from "../../src/cli/deps/update.js";
import type { StreamRunner } from "../../src/cli/deps/plugins.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-update-"));
  tempDirs.push(dir);
  return dir;
}

function makeInstallRoot(): { root: string; cli: string } {
  const root = tempDir();
  const release = path.join(root, "release");
  const cli = path.join(release, "scripts", "self-update", "cli.mjs");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "", "utf8");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "current.json"),
    `${JSON.stringify({ dir: release })}\n`,
    "utf8",
  );
  return { root, cli };
}

function fakeReporter(events: Array<Record<string, unknown>>): Reporter {
  return {
    mode: "jsonl",
    event: (event: Record<string, unknown>) => {
      events.push(event);
    },
    info: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
  } as unknown as Reporter;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("update 参数映射", () => {
  it("check 追加 --check 与 --jsonl", () => {
    expect(updateArgs("check")).toEqual(["--check", "--jsonl"]);
    expect(updateArgs("check", "1.2.3")).toEqual(["--check", "--jsonl"]);
  });

  it("apply 追加 --version（可选）与 --jsonl", () => {
    expect(updateArgs("apply")).toEqual(["--jsonl"]);
    expect(updateArgs("apply", "v1.2.3")).toEqual(["--version", "v1.2.3", "--jsonl"]);
  });

  it("runUpdate 把映射后的参数传给 self-update CLI", async () => {
    const { root, cli } = makeInstallRoot();
    const calls: string[][] = [];
    const runner: StreamRunner = async (_command, args) => {
      calls.push(args);
      return { code: 0, signal: null };
    };

    await runUpdate({ root, action: "check", reporter: fakeReporter([]), runner });
    await runUpdate({ root, action: "apply", version: "1.2.3", reporter: fakeReporter([]), runner });

    expect(calls[0]).toEqual([cli, "--check", "--jsonl"]);
    expect(calls[1]).toEqual([cli, "--version", "1.2.3", "--jsonl"]);
  });
});

describe("update 事件与失败", () => {
  it("check 事件解析出目标版本、当前版本与是否最新", async () => {
    const { root } = makeInstallRoot();
    const runner: StreamRunner = async (_command, _args, options) => {
      options?.onLine?.(
        JSON.stringify({
          type: "event",
          schema_version: 1,
          event: "check",
          current_version: "0.2.3",
          target_version: "0.3.0",
          up_to_date: false,
        }),
        "stdout",
      );
      return { code: 0, signal: null };
    };

    const result = await runUpdate({
      root,
      action: "check",
      reporter: fakeReporter([]),
      runner,
    });

    expect(result).toMatchObject({
      action: "check",
      version: "0.3.0",
      current_version: "0.2.3",
      up_to_date: false,
      restarted: false,
    });
  });

  it("透传子进程 JSON 事件，非 JSON 行包成 log", async () => {
    const { root } = makeInstallRoot();
    const events: Array<Record<string, unknown>> = [];
    const runner: StreamRunner = async (_command, _args, options) => {
      options?.onLine?.(
        JSON.stringify({ type: "event", event: "progress", job: "update", percent: 42 }),
        "stdout",
      );
      options?.onLine?.("[self-update] 下载安装包", "stdout");
      return { code: 0, signal: null };
    };

    const result = await runUpdate({
      root,
      action: "apply",
      reporter: fakeReporter(events),
      runner,
    });

    expect(result).toEqual({ action: "apply", version: null, restarted: true });
    expect(events[0]).toMatchObject({ event: "progress", percent: 42 });
    expect(events[0]).not.toHaveProperty("type");
    expect(events[1]).toMatchObject({ event: "log", service: "update" });
  });

  it("非 0 退出码为 UPDATE_FAILED；出现回滚事件时为 UPDATE_ROLLED_BACK", async () => {
    const { root } = makeInstallRoot();

    const plainFailure: StreamRunner = async (_command, _args, options) => {
      options?.onLine?.(
        JSON.stringify({
          type: "event",
          event: "log",
          message: "没有可回滚的上一版本，已保留新版本目录",
        }),
        "stdout",
      );
      return { code: 1, signal: null };
    };
    await expect(
      runUpdate({ root, action: "apply", reporter: fakeReporter([]), runner: plainFailure }),
    ).rejects.toMatchObject({ code: "UPDATE_FAILED", exitCode: 1 });

    const rolledBack: StreamRunner = async (_command, _args, options) => {
      options?.onLine?.(
        JSON.stringify({ type: "event", event: "log", message: "更新失败，已回滚到 0.2.3" }),
        "stdout",
      );
      return { code: 1, signal: null };
    };
    await expect(
      runUpdate({ root, action: "apply", reporter: fakeReporter([]), runner: rolledBack }),
    ).rejects.toMatchObject({ code: "UPDATE_ROLLED_BACK", exitCode: 1 });
  });
});
