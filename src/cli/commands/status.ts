import type { CommandFn } from "../context.js";
import { probeStack, type ServiceProbe, type StackStatus } from "../runtime/stack.js";

function formatProbe(probe: ServiceProbe, withVersion = false): [string, string, string] {
  const state = probe.up ? "up" : "down";
  const latency = typeof probe.latency_ms === "number" ? `${probe.latency_ms}ms` : "-";

  const details: string[] = [];
  if (withVersion && probe.version) details.push(`v${probe.version}`);
  if (withVersion && typeof probe.uptime_s === "number") details.push(`uptime ${probe.uptime_s}s`);
  if (!probe.up && probe.error) details.push(probe.error);

  return [state, latency, details.length > 0 ? details.join(", ") : "-"];
}

function renderHuman(status: StackStatus): string {
  const rows: Array<[string, string, string, string]> = [];
  for (const name of ["gateway", "searxng", "flaresolverr"] as const) {
    const [state, latency, detail] = formatProbe(status.services[name], name === "gateway");
    rows.push([name, state, latency, detail]);
  }

  const header = ["SERVICE", "STATUS", "LATENCY", "DETAIL"];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();

  const supervisor = status.supervisor;
  const supervisorLine = `${supervisor.mode}${supervisor.active ? " (active)" : " (inactive)"}${
    supervisor.managed ? "" : " · 未使用服务管理器"
  }`;

  return [
    formatRow(header),
    ...rows.map((row) => formatRow(row)),
    "",
    `supervisor: ${supervisorLine}`,
  ].join("\n");
}

export const run: CommandFn = async ({ root }) => {
  const status = await probeStack(root);
  return { data: status, human: renderHuman(status) };
};
