/**
 * 配置校验：把候选文本写到临时目录，用 loadSettingsFrom 跑真正的 schema + 迁移检查。
 *
 * 不复制任何校验逻辑；校验失败一律抛 CONFIG_INVALID（退出码 4），且不触碰目标文件。
 */

import fs, { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { configPaths, readTextIfExists } from "./gateway.js";
import { loadSettingsFrom } from "../../settings/load.js";

export interface ConfigCandidate {
  configText: string;
  /** undefined 表示 secrets.yaml 不存在（与运行期加载行为一致）。 */
  secretsText?: string;
}

export interface ValidateResult {
  warnings: string[];
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 把临时路径替换成用户看得懂的文件名。 */
function sanitize(message: string, configPath: string, secretsPath: string): string {
  return message
    .split(configPath)
    .join("gateway.yaml")
    .split(secretsPath)
    .join("secrets.yaml");
}

/**
 * 校验候选配置文本。
 *
 * 用空环境变量加载：校验只看文件结构，外部 GATEWAY_TOKEN 等不能掩盖/制造问题。
 */
export function validateConfigTexts(candidate: ConfigCandidate): ValidateResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-config-"));
  const configPath = path.join(dir, "gateway.yaml");
  const secretsPath = path.join(dir, "secrets.yaml");

  try {
    fs.writeFileSync(configPath, candidate.configText, "utf8");
    if (candidate.secretsText !== undefined) {
      fs.writeFileSync(secretsPath, candidate.secretsText, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(secretsPath, 0o600);
    }

    const loaded = loadSettingsFrom(configPath, secretsPath, {});
    return { warnings: loaded.warnings.map((warning) => sanitize(warning, configPath, secretsPath)) };
  } catch (error) {
    throw new CliError(
      "CONFIG_INVALID",
      EXIT.INVALID,
      sanitize(describe(error), configPath, secretsPath),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 校验磁盘上的当前配置（config validate：只读，不写不重启）。 */
export function validateConfigFiles(root: string): ValidateResult {
  const paths = configPaths(root);
  if (!existsSync(paths.config)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到配置文件：${paths.config}`);
  }

  const configText = readTextIfExists(paths.config);
  if (configText === undefined) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `无法读取配置文件：${paths.config}`);
  }

  return validateConfigTexts({
    configText,
    secretsText: readTextIfExists(paths.secrets),
  });
}
