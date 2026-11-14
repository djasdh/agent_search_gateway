import type { CommandFn } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { runSupervisor } from "../runtime/supervisor.js";

export const run: CommandFn = async ({ root }) => {
  const code = await runSupervisor(root);
  if (code !== 0) {
    throw new CliError(
      "START_FAILED",
      EXIT.FAIL,
      `supervisor 异常退出（退出码 ${code}）`,
      { exit_code: code },
    );
  }
  return { data: { state: "stopped" }, human: "supervisor 已退出" };
};
