/** data/logs/*.log 的读取、合并与 -f 增量跟随。 */

import fs from "node:fs";
import path from "node:path";
import { rootPaths } from "../root.js";
import { CliError, EXIT } from "../errors.js";
import { sleep } from "./process.js";

export const ALL_SERVICES = ["gateway", "supervisor", "searxng", "flaresolverr"] as const;
export const DEFAULT_SERVICES = ["gateway", "supervisor"] as const;

export type LogService = (typeof ALL_SERVICES)[number];

export interface LogEntry {
  service: string;
  /** 行首 ISO 时间戳；无时间戳的续行没有该字段。 */
  at?: string;
  /** 完整原始行（续行会以 \n 拼接到上一条）。 */
  line: string;
}

const TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/;

export function isKnownService(name: string): name is LogService {
  return (ALL_SERVICES as readonly string[]).includes(name);
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** 把同一文件的若干行解析为条目；无时间戳的行附到上一条。 */
export function buildEntries(lines: string[], service: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const raw of lines) {
    const line = stripCr(raw);
    const match = TIMESTAMP_RE.exec(line);
    if (match) {
      entries.push({ service, at: match[1]!, line });
      continue;
    }
    const previous = entries[entries.length - 1];
    if (previous) {
      previous.line += `\n${line}`;
    } else {
      entries.push({ service, line });
    }
  }
  return entries;
}

/** 稳定排序：有时间的按时间，无时间戳的条目排在最前。 */
export function mergeEntries(entries: LogEntry[]): LogEntry[] {
  const decorated = entries.map((entry, index) => ({ entry, index }));
  decorated.sort((a, b) => {
    const ta = a.entry.at ? Date.parse(a.entry.at) : Number.NaN;
    const tb = b.entry.at ? Date.parse(b.entry.at) : Number.NaN;
    const va = Number.isNaN(ta) ? null : ta;
    const vb = Number.isNaN(tb) ? null : tb;
    if (va !== null && vb !== null && va !== vb) return va - vb;
    if (va === null && vb !== null) return -1;
    if (va !== null && vb === null) return 1;
    return a.index - b.index;
  });
  return decorated.map((item) => item.entry);
}

/** 读取文件末尾 count 行；文件不存在返回空数组。 */
export function readTailLines(file: string, count: number): string[] {
  if (count <= 0) return [];

  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];

    let length = Math.min(size, Math.max(64 * 1024, count * 128));
    for (;;) {
      const position = Math.max(0, size - length);
      const buffer = Buffer.alloc(size - position);
      fs.readSync(fd, buffer, 0, buffer.length, position);

      let lines = buffer.toString("utf8").split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      if (position > 0) {
        // 块从行中间开始时丢弃被截断的首行片段；恰好落在行首时保留。
        const one = Buffer.alloc(1);
        fs.readSync(fd, one, 0, 1, position - 1);
        if (one[0] !== 0x0a) lines = lines.slice(1);
      }

      if (position === 0 || lines.length > count) {
        return lines.slice(-count);
      }
      if (length >= size) return lines.slice(-count);
      length = Math.min(size, length * 2);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** 读取多个日志文件的末尾行，按行首时间戳稳定合并。 */
export function readMergedLogs(root: string, services: string[], lines = 200): LogEntry[] {
  const dir = rootPaths(root).logsDir;
  const entries: LogEntry[] = [];
  for (const service of services) {
    const file = path.join(dir, `${service}.log`);
    entries.push(...buildEntries(readTailLines(file, lines), service));
  }
  return mergeEntries(entries);
}

export interface FollowLogsOptions {
  root: string;
  services: string[];
  onEntry: (entry: LogEntry) => void;
  signal?: AbortSignal;
  /** 轮询间隔，默认 500ms。 */
  pollMs?: number;
  /** 小窗排序等待，默认 200ms。 */
  windowMs?: number;
}

interface FollowState {
  offset: number;
  partial: string;
  lastAt?: string;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readIncrement(file: string, state: FollowState): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return "";
  }

  if (stat.size < state.offset) {
    // 文件被截断或轮转：从头读取。
    state.offset = 0;
    state.partial = "";
  }
  if (stat.size === state.offset) return "";

  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const length = stat.size - state.offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, state.offset);
    state.offset = stat.size;
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function entriesFromChunk(
  text: string,
  service: string,
  state: FollowState,
): LogEntry[] {
  if (!text) return [];
  const combined = state.partial + text;
  const lines = combined.split("\n");
  state.partial = lines.pop() ?? "";

  const entries = buildEntries(lines, service);
  for (const entry of entries) {
    if (entry.at) {
      state.lastAt = entry.at;
    } else if (state.lastAt) {
      // 续行在流式模式下已经单独输出，用上一条的时间戳标注。
      entry.at = state.lastAt;
    }
  }
  return entries;
}

/**
 * 从当前 EOF 开始跟随新增行；先按 500ms 轮询读取，再等 200ms 小窗统一排序输出。
 * 不会输出启动前的历史行。
 */
export async function followLogs(options: FollowLogsOptions): Promise<void> {
  const dir = rootPaths(options.root).logsDir;
  const pollMs = options.pollMs ?? 500;
  const windowMs = options.windowMs ?? 200;
  const states = new Map<string, FollowState>();

  for (const service of options.services) {
    states.set(service, {
      offset: fileSize(path.join(dir, `${service}.log`)),
      partial: "",
    });
  }

  let stopped = false;
  const onAbort = (): void => {
    stopped = true;
  };
  options.signal?.addEventListener("abort", onAbort);

  const readBatch = (): LogEntry[] => {
    const batch: LogEntry[] = [];
    for (const [service, state] of states) {
      const file = path.join(dir, `${service}.log`);
      const text = readIncrement(file, state);
      batch.push(...entriesFromChunk(text, service, state));
    }
    return batch;
  };

  try {
    while (!stopped) {
      await sleep(pollMs);
      if (stopped) break;

      let batch = readBatch();
      if (batch.length === 0) continue;

      // 给同一时间窗内到达的行一个排序机会。
      await sleep(windowMs);
      if (stopped) {
        batch = mergeEntries(batch);
        for (const entry of batch) options.onEntry(entry);
        break;
      }
      batch.push(...readBatch());
      for (const entry of mergeEntries(batch)) options.onEntry(entry);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** --lines 参数校验。 */
export function parseLineCount(value: number | undefined, fallback = 200): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "--lines 需要一个正整数");
  }
  return value;
}
