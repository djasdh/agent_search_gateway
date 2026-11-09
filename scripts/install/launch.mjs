/** 生成/读取统一的进程启动清单 data/runtime/launch.json。 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function launchFile(installRoot) {
  return path.join(installRoot, 'data', 'runtime', 'launch.json');
}

export async function writeLaunchJson({ installRoot, services }) {
  const file = launchFile(installRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    services: services.filter(Boolean).map((item) => ({
      name: item.name,
      command: item.command,
      cwd: item.cwd,
      env: item.env || {},
      health: item.health || null,
    })),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return file;
}

export async function readLaunchJson({ installRoot }) {
  const text = await fs.readFile(launchFile(installRoot), 'utf8');
  return JSON.parse(text);
}
