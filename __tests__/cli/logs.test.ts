import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reporter } from "../../src/cli/output.js";
import {
  buildEntries,
  followLogs,
  mergeEntries,
  readMergedLogs,
  readTailLines,
  type LogEntry,
} from "../../src/cli/runtime/logs.js";
import { run as logsRun } from "../../src/cli/commands/logs.js";

const tempDirs: string[] = [];
let root = "";

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-logs-"));
  tempDirs.push(dir);
  return dir;
}

function writeLog(dir: string, service: string, lines: string[]): string {
  const logsDir = path.join(dir, "data", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `${service}.log`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

const jsonReporter = new Reporter({ json: true, jsonl: false });

beforeAll(() => {
  root = tempRoot();
  writeLog(root, "gateway", [
    "2026-11-13T06:00:02.000Z [gateway] second",
    "continuation A",
    "continuation B",
    "2026-11-13T06:00:04.000Z [gateway] fourth",
  ]);
  writeLog(root, "supervisor", [
    "2026-11-13T06:00:01.000Z [supervisor] first",
    "2026-11-13T06:00:03.000Z [supervisor] third",
  ]);
});

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("日志合并", () => {
  it("按行首 ISO 时间戳稳定排序，并把无时间戳的行附到上一条", () => {
    const entries = readMergedLogs(root, ["gateway", "supervisor"], 200);

    expect(entries.map((entry) => entry.at)).toEqual([
      "2026-11-13T06:00:01.000Z",
      "2026-11-13T06:00:02.000Z",
      "2026-11-13T06:00:03.000Z",
      "2026-11-13T06:00:04.000Z",
    ]);
    expect(entries[1]!.service).toBe("gateway");
    expect(entries[1]!.line).toContain("continuation A\ncontinuation B");
    expect(entries[2]!.service).toBe("supervisor");
  });

  it("同一时间戳保持输入顺序（稳定排序）", () => {
    const entries = mergeEntries([
      { service: "gateway", at: "2026-11-13T06:00:03.000Z", line: "g" },
      { service: "supervisor", at: "2026-11-13T06:00:03.000Z", line: "s" },
    ]);
    expect(entries.map((entry) => entry.service)).toEqual(["gateway", "supervisor"]);
  });

  it("文件开头的无时间戳行单独成为条目，并排在带时间的条目之前", () => {
    const entries = buildEntries(["orphan", "2026-11-13T06:00:01.000Z [x] later"], "gateway");
    const merged = mergeEntries(entries);
    expect(merged[0]!.line).toBe("orphan");
    expect(merged[0]!.at).toBeUndefined();
    expect(merged[1]!.at).toBe("2026-11-13T06:00:01.000Z");
  });

  it("readTailLines 只取末尾 N 行", () => {
    const file = path.join(root, "data", "logs", "gateway.log");
    expect(readTailLines(file, 2)).toEqual([
      "continuation B",
      "2026-11-13T06:00:04.000Z [gateway] fourth",
    ]);
    expect(readTailLines(path.join(root, "data", "logs", "missing.log"), 10)).toEqual([]);
  });

  it("logs --json 返回 data.lines，未知服务退出码 2", async () => {
    const result = await logsRun({ root, reporter: jsonReporter, rest: ["all"] });
    const data = result.data as { lines: LogEntry[] };
    expect(data.lines.length).toBeGreaterThan(0);
    expect(data.lines[0]).toHaveProperty("service");
    expect(data.lines[0]).toHaveProperty("line");

    await expect(
      logsRun({ root, reporter: jsonReporter, rest: ["nope"] }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("--json 与 -f 互斥，退出码 2", async () => {
    await expect(
      logsRun({ root, reporter: jsonReporter, rest: ["-f"] }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("日志跟随", () => {
  it("-f 只输出启动后新增的行，不重复历史", async () => {
    const dir = tempRoot();
    const file = writeLog(dir, "gateway", ["2026-11-13T06:00:00.000Z [gateway] old"]);

    const seen: LogEntry[] = [];
    const controller = new AbortController();
    const following = followLogs({
      root: dir,
      services: ["gateway"],
      onEntry: (entry) => seen.push(entry),
      signal: controller.signal,
      pollMs: 20,
      windowMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.appendFileSync(file, "2026-11-13T06:00:10.000Z [gateway] new\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 180));
    controller.abort();
    await following;

    expect(seen).toHaveLength(1);
    expect(seen[0]!.line).toContain("new");
    expect(seen[0]!.at).toBe("2026-11-13T06:00:10.000Z");
    expect(seen[0]!.line).not.toContain("old");
  });
});
