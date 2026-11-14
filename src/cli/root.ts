/** 安装根、版本目录与平台路径解析。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, EXIT } from "./errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface CurrentState {
  dir: string;
  version?: string;
  previousDir?: string | null;
  previousVersion?: string | null;
}

function exists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function walkUp(start: string, hit: (dir: string) => boolean): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (hit(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 根解析：--root > 向上找 gateway.yaml > 向上找 data/current* > cwd。 */
export function resolveRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);

  const byConfig = walkUp(HERE, (dir) => exists(path.join(dir, "gateway.yaml")));
  if (byConfig) return byConfig;

  const byCurrent = walkUp(
    HERE,
    (dir) => exists(path.join(dir, "data", "current.json")) || exists(path.join(dir, "data", "current")),
  );
  if (byCurrent) return byCurrent;

  return process.cwd();
}

export function readCurrent(root: string): CurrentState {
  const jsonPath = path.join(root, "data", "current.json");
  if (exists(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
      if (typeof data.dir !== "string" || !data.dir.trim()) {
        throw new Error("current.json 缺少 dir");
      }
      return {
        dir: path.isAbsolute(data.dir) ? data.dir : path.resolve(root, data.dir),
        version: typeof data.version === "string" ? data.version : undefined,
        previousDir: typeof data.previousDir === "string" ? data.previousDir : null,
        previousVersion: typeof data.previousVersion === "string" ? data.previousVersion : null,
      };
    } catch (error) {
      throw new CliError(
        "SCHEMA_MISMATCH",
        EXIT.INVALID,
        `data/current.json 无法解析：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const linkPath = path.join(root, "data", "current");
  if (exists(linkPath)) {
    return { dir: fs.realpathSync(linkPath) };
  }

  throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到版本目录：${path.join(root, "data", "current")}`);
}

/** 当前 release 根目录（含 dist/、scripts/、node_modules/）。 */
export function releaseDir(root: string): string {
  return readCurrent(root).dir;
}

export function nodePath(root: string): string {
  const local =
    process.platform === "win32"
      ? path.join(root, "data", "toolchain", "node", "node.exe")
      : path.join(root, "data", "toolchain", "node", "bin", "node");
  return exists(local) ? local : process.execPath;
}

export function binAsgPath(root: string): string {
  return path.join(root, "bin", "asg.mjs");
}

export function version(root: string): string {
  const current = (() => {
    try {
      return readCurrent(root);
    } catch {
      return null;
    }
  })();
  if (current?.version) return current.version;

  const candidates = [
    current ? path.join(current.dir, "package.json") : null,
    path.join(HERE, "..", "..", "package.json"),
  ].filter((value): value is string => Boolean(value));

  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
      if (typeof data.version === "string") return data.version;
    } catch {
      // 继续尝试下一个
    }
  }
  return "unknown";
}

export interface RootPaths {
  root: string;
  config: string;
  secrets: string;
  launch: string;
  runtimeDir: string;
  logsDir: string;
  supervisorPid: string;
  searxngSettings: string;
}

export function rootPaths(root: string): RootPaths {
  const runtimeDir = path.join(root, "data", "runtime");
  return {
    root,
    config: path.join(root, "gateway.yaml"),
    secrets: path.join(root, "secrets.yaml"),
    launch: path.join(runtimeDir, "launch.json"),
    runtimeDir,
    logsDir: path.join(root, "data", "logs"),
    supervisorPid: path.join(runtimeDir, "supervisor.pid"),
    searxngSettings: path.join(root, "data", "deps", "searxng", "settings.yml"),
  };
}

export { exists };
