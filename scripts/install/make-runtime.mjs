#!/usr/bin/env node
/** CI 用：根据发布产物与 runtime/pins.json 生成 runtime.json。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [artifactsDir, pinsFile, version, output] = process.argv.slice(2);
if (!artifactsDir || !pinsFile || !version || !output) {
  console.error('用法: node make-runtime.mjs <artifacts> <pins.json> <version> <output>');
  process.exit(2);
}

const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
const assets = {};
for (const name of fs.readdirSync(artifactsDir)) {
  const match = name.match(
    /^agent-search-gateway-.+-(linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64)\.(?:tar\.gz|zip)$/,
  );
  if (!match) continue;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(path.join(artifactsDir, name)));
  assets[match[1]] = { name, sha256: hash.digest('hex') };
}

const runtime = { version, assets, deps: pins };
fs.writeFileSync(output, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(`已生成 ${output}: ${Object.keys(assets).join(', ')}`);
