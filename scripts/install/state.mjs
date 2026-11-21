#!/usr/bin/env node
/**
 * 安装状态写入。
 *
 * data/current.json 是 bin/asg.mjs、doctor、自更新定位当前版本目录的唯一来源，
 * 必须写绝对路径，并且路径里可能出现引号、反斜杠等字符，所以统一用
 * JSON.stringify 生成内容后原子替换，不能手拼 JSON 文本。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 状态文件里不保存依赖调用时 cwd 的路径：相对路径一律按安装根解析。 */
function absoluteFrom(root, value) {
  if (!value) return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

/**
 * 写入 data/current.json。
 *
 * @param {object} options
 * @param {string} options.root 安装根目录
 * @param {string} options.dir 当前版本目录（相对路径按 root 解析）
 * @param {string} options.version 当前版本
 * @param {string|null} [options.previousDir] 上一版本目录
 * @param {string|null} [options.previousVersion] 上一版本
 */
export async function writeCurrentState({
  root,
  dir,
  version,
  previousDir = null,
  previousVersion = null,
}) {
  if (!root) throw new Error('writeCurrentState 需要 root');
  if (!dir) throw new Error('writeCurrentState 需要 dir');

  const rootDir = path.resolve(root);
  const payload = {
    dir: absoluteFrom(rootDir, dir),
    version: version || 'unknown',
    previousDir: absoluteFrom(rootDir, previousDir),
    previousVersion: previousVersion || null,
    updatedAt: new Date().toISOString(),
  };

  const dataDir = path.join(rootDir, 'data');
  const file = path.join(dataDir, 'current.json');
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;

  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return payload;
}

function parseArgs(argv) {
  const opts = {
    root: '',
    dir: '',
    version: '',
    previousDir: null,
    previousVersion: null,
  };
  const next = (index, name) => {
    if (index >= argv.length) throw new Error(`${name} 需要一个值`);
    return argv[index];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        opts.root = next(++i, arg);
        break;
      case '--dir':
        opts.dir = next(++i, arg);
        break;
      case '--version':
        opts.version = next(++i, arg);
        break;
      case '--previous-dir':
        opts.previousDir = next(++i, arg) || null;
        break;
      case '--previous-version':
        opts.previousVersion = next(++i, arg) || null;
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  return opts;
}

/**
 * 切换 data/current（Unix 符号链接）并写 current.json。
 *
 * Windows 只依赖 current.json，不创建符号链接。
 */
export async function switchCurrent({
  root,
  dir,
  version,
  previousDir = null,
  previousVersion = null,
}) {
  const rootDir = path.resolve(root);
  const target = absoluteFrom(rootDir, dir);
  if (!target) throw new Error('switchCurrent 需要 dir');

  if (process.platform !== 'win32') {
    const current = path.join(rootDir, 'data', 'current');
    const existing = await fs.lstat(current).catch(() => null);
    if (existing && !existing.isSymbolicLink()) {
      throw new Error(`data/current 已存在且不是符号链接：${current}`);
    }
    const linkTarget = path.relative(path.dirname(current), target);
    const tmp = `${current}.tmp-${process.pid}-${Date.now()}`;
    await fs.mkdir(path.dirname(current), { recursive: true });
    await fs.rm(tmp, { force: true });
    await fs.symlink(linkTarget, tmp, 'dir');
    try {
      await fs.rename(tmp, current);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  return writeCurrentState({
    root: rootDir,
    dir: target,
    version,
    previousDir,
    previousVersion,
  });
}

/** 读取切换前状态，供 previous 计算；缺失/损坏时返回空值。 */
export async function readCurrentSwitchState(root) {
  const rootDir = path.resolve(root);
  const readJson = async (file) => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  };

  const installed = await readJson(path.join(rootDir, 'data', 'installed.json'));
  const current = await readJson(path.join(rootDir, 'data', 'current.json'));
  return {
    installedCurrent: installed?.current ?? null,
    installedPrevious: installed?.previous ?? null,
    current: current ?? null,
  };
}

async function main(argv = process.argv.slice(2)) {
  await writeCurrentState(parseArgs(argv));
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[install] 错误: ${error.message}`);
      process.exit(1);
    },
  );
}
