/** asg browser status|install */

import { takeFlag } from "../args.js";
import type { CommandFn } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { browserStatus, installBrowser, type BrowserStatus } from "../deps/browser.js";

const USAGE = `用法: asg browser <status|install> [--full]

  status         查看 Playwright 缓存（只读）
  install        安装 chromium headless shell（约 150MB）
  install --full 安装完整 Chromium（含 headless shell）

浏览器由网关懒加载，安装后不需要重启服务。`;

function renderStatus(status: BrowserStatus): string {
  const mark = (value: boolean): string => (value ? "yes" : "no");
  return [
    `缓存目录: ${status.path}`,
    `headless shell: ${mark(status.headless_shell)}`,
    `chromium:       ${mark(status.chromium)}`,
  ].join("\n");
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [subcommand] = rest;

  if (!subcommand || subcommand === "status") {
    if (rest.length > 1) {
      throw new CliError("UNEXPECTED", EXIT.USAGE, `status 不接受额外参数：${rest.slice(1).join(" ")}`);
    }
    const status = browserStatus();
    return { data: status, human: renderStatus(status) };
  }

  if (subcommand === "install") {
    const args = rest.slice(1);
    const full = takeFlag(args, "--full");
    if (args.length > 0) {
      throw new CliError("UNEXPECTED", EXIT.USAGE, `未知参数：${args.join(" ")}\n\n${USAGE}`);
    }
    const status = await installBrowser({ root, full, reporter });
    return {
      data: status,
      human: [
        `Playwright chromium ${full ? "（完整版）" : "（headless shell）"}已安装。`,
        `缓存目录: ${status.path}`,
        "浏览器在下次使用时由网关懒加载，无需重启服务。",
      ].join("\n"),
    };
  }

  if (subcommand === "-h" || subcommand === "--help") {
    return { data: { usage: USAGE }, human: USAGE };
  }

  throw new CliError("UNEXPECTED", EXIT.USAGE, `未知子命令：${subcommand}\n\n${USAGE}`);
};
