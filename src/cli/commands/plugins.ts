/** asg plugins list|install|remove */

import type { CommandFn } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { listPlugins, pluginAction, type PluginStatus } from "../deps/plugins.js";

const USAGE = `用法: asg plugins <list|install|remove> [name]

  list           查看插件安装与启用状态（只读，离线可用）
  install <name> 安装并整栈重启
  remove <name>  卸载并整栈重启

旧名：bili、ytdlp、opencli、article
规范通道：bilibili:kukemc、bilibili:ytdlp、bilibili:article、weibo:opencli`;

function renderList(plugins: PluginStatus[]): string {
  const header = ["NAME", "PLATFORM", "CHANNEL", "INSTALLED", "VERSION", "ENABLED"];
  const rows = plugins.map((plugin) => [
    plugin.name,
    plugin.platform,
    plugin.channel_id,
    plugin.installed ? "yes" : "no",
    plugin.version ?? "-",
    plugin.enabled ? "yes" : "no",
  ]);

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();

  return [formatRow(header), ...rows.map((row) => formatRow(row))].join("\n");
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [subcommand, ...args] = rest;

  if (!subcommand || subcommand === "list") {
    if (args.length > 0) {
      throw new CliError("UNEXPECTED", EXIT.USAGE, `list 不接受额外参数：${args.join(" ")}`);
    }
    const plugins = listPlugins(root);
    return { data: { plugins }, human: renderList(plugins) };
  }

  if (subcommand === "install" || subcommand === "remove") {
    const name = args[0];
    if (!name || args.length > 1) {
      throw new CliError("UNEXPECTED", EXIT.USAGE, `用法: asg plugins ${subcommand} <name>`);
    }
    const result = await pluginAction({
      root,
      name,
      action: subcommand === "install" ? "install" : "uninstall",
      reporter,
    });
    const verb = subcommand === "install" ? "安装" : "卸载";
    return {
      data: result,
      human: `${result.name} 已${verb}，整栈已重启。`,
    };
  }

  if (subcommand === "-h" || subcommand === "--help") {
    return { data: { usage: USAGE }, human: USAGE };
  }

  throw new CliError("UNEXPECTED", EXIT.USAGE, `未知子命令：${subcommand}\n\n${USAGE}`);
};
