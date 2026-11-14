import { takeFlag, takeNumber } from "../args.js";
import type { CommandFn } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import {
  ALL_SERVICES,
  DEFAULT_SERVICES,
  followLogs,
  isKnownService,
  parseLineCount,
  readMergedLogs,
  type LogEntry,
} from "../runtime/logs.js";

function resolveServices(rest: string[]): string[] {
  if (rest.length === 0) return [...DEFAULT_SERVICES];
  if (rest.includes("all")) return [...ALL_SERVICES];

  const services: string[] = [];
  const seen = new Set<string>();
  for (const name of rest) {
    if (!isKnownService(name)) {
      throw new CliError(
        "UNEXPECTED",
        EXIT.USAGE,
        `未知服务：${name}（可选：${ALL_SERVICES.join(" / ")} / all）`,
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      services.push(name);
    }
  }
  return services;
}

function eventOf(entry: LogEntry): Record<string, unknown> {
  return {
    service: entry.service,
    ...(entry.at ? { at: entry.at } : {}),
  };
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const follow = takeFlag(rest, "-f", "--follow");
  const lines = parseLineCount(takeNumber(rest, "--lines"));
  const services = resolveServices(rest);

  if (follow && reporter.mode === "json") {
    throw new CliError("UNEXPECTED", EXIT.USAGE, "--json 不支持 -f，流式输出请用 --jsonl");
  }

  if (follow) {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await followLogs({
        root,
        services,
        signal: controller.signal,
        onEntry: (entry) => reporter.line(entry.line, eventOf(entry)),
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return { data: { streamed: true, services }, human: "" };
  }

  const entries = readMergedLogs(root, services, lines);

  if (reporter.mode === "json") {
    return {
      data: {
        lines: entries.map((entry) => ({
          service: entry.service,
          ...(entry.at ? { at: entry.at } : {}),
          line: entry.line,
        })),
      },
    };
  }

  for (const entry of entries) {
    reporter.line(entry.line, eventOf(entry));
  }

  return { data: { count: entries.length }, human: "" };
};
