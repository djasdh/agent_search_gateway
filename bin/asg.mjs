#!/usr/bin/env node
/**
 * asg 稳定入口（安装根 bin/asg.mjs）。
 * 只负责解析当前版本目录，把参数交给 dist/cli/asg.js；同进程执行，不额外起 Node。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const linkEntry = path.join(root, "data", "current", "dist", "cli", "asg.js");
const stateFile = path.join(root, "data", "current.json");
const devEntry = path.join(root, "dist", "cli", "asg.js");

let entry = linkEntry;
if (!fs.existsSync(entry)) {
  entry = fs.existsSync(stateFile)
    ? path.join(JSON.parse(fs.readFileSync(stateFile, "utf8")).dir, "dist", "cli", "asg.js")
    : devEntry;
}
if (!fs.existsSync(entry)) {
  console.error(`[asg] 未找到 CLI 入口：${entry}（请先安装或执行 npm run build）`);
  process.exit(1);
}

try {
  const { main } = await import(pathToFileURL(entry).href);
  process.exitCode = await main(["--root", root, ...process.argv.slice(2)]);
} catch (error) {
  console.error(`[asg] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
