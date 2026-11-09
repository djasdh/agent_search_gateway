/** Playwright 浏览器安装（chromium）。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
}

export async function installBrowser({ currentDir, logger }) {
  const cli = path.join(currentDir, 'node_modules', 'playwright', 'cli.js');
  try {
    await fs.access(cli);
  } catch {
    throw new Error(`未找到 Playwright CLI: ${cli}；请确认完整包包含 node_modules`);
  }
  logger?.('安装 Playwright chromium（首次约 150MB）...');
  const result = await run(process.execPath, [cli, 'install', 'chromium'], currentDir);
  if (result.error) throw new Error(`Playwright 安装失败: ${result.error.message}`);
  if (result.code !== 0) throw new Error(`Playwright install chromium 退出码 ${result.code}`);
  logger?.('Playwright chromium 已就绪');
  return { installed: true };
}
