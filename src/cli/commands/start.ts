import type { CommandFn } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { startStack } from "../runtime/stack.js";

export const run: CommandFn = async ({ root, reporter, rest }) => {
  if (rest.length > 0) {
    throw new CliError("UNEXPECTED", EXIT.USAGE, `start 不接受参数：${rest.join(" ")}`);
  }

  const result = await startStack(root, reporter);
  const mode = result.supervisor.mode;
  return {
    data: result,
    human: result.state === "already_running" ? `已在运行（${mode}）` : `已启动（${mode}）`,
  };
};
