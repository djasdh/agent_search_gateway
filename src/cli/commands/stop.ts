import type { CommandFn } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { stopStack } from "../runtime/stack.js";

export const run: CommandFn = async ({ root, reporter, rest }) => {
  if (rest.length > 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `stop 不接受参数：${rest.join(" ")}`);
  }

  const result = await stopStack(root, reporter);
  return {
    data: result,
    human: result.state === "already_stopped" ? "未在运行" : "已停止",
  };
};
