/** 网关版本：优先 release 的 version.json，其次 package.json，最后 unknown。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readVersion(file: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
    return typeof data.version === "string" && data.version.trim() ? data.version.trim() : null;
  } catch {
    return null;
  }
}

function detect(): string {
  const candidates = [
    path.join(HERE, "..", "version.json"),
    path.join(HERE, "..", "package.json"),
  ];
  for (const file of candidates) {
    const found = readVersion(file);
    if (found) return found;
  }
  return "unknown";
}

export const GATEWAY_VERSION = detect();
