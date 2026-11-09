/**
 * Windows 兼容补丁与 ZIP 解压工具。
 *
 * searxng 是 Unix 原生项目：`searx/valkeydb.py` 顶层 `import pwd`，而 Windows
 * 没有 pwd 模块，`searx/webapp.py` 又会无条件导入 valkeydb，导致启动直接
 * ModuleNotFoundError。这里提供幂等补丁，把 pwd 访问降级为可选。
 *
 * 另外 GitHub 的源码 ZIP 里有 `utils/templates/etc/...` 之类的模板文件，
 * 文件名含 Windows 非法字符 `:`，系统解压工具会失败。这里自带一个最小
 * ZIP 读取器（仅支持 stored / deflate），在 Windows 上跳过非法条目。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// valkeydb.py 补丁
// ---------------------------------------------------------------------------

const IMPORT_MARKER = 'except ImportError:  # Windows 没有 pwd 模块';
const GUARD_MARKER = 'if pwd is not None:';

/**
 * 给 searx/valkeydb.py 打 Windows 兼容补丁（幂等）。
 *
 * 改动：
 *   1. `import pwd` -> try/except ImportError，缺失时 `pwd = None`；
 *   2. `pwd.getpwuid(os.getuid())` 日志分支 -> 仅在有 pwd 时调用，
 *      否则退回 `USERNAME` 环境变量与进程 PID。
 *
 * @param {string} text 原始文件内容
 * @returns {string} 补丁后的内容；已打过补丁时原样返回
 */
export function patchValkeyDb(text) {
  if (typeof text !== 'string') {
    throw new TypeError('patchValkeyDb 需要字符串内容');
  }
  // 幂等：两个标记都在，说明已经打过补丁
  if (text.includes(IMPORT_MARKER) && text.includes(GUARD_MARKER)) {
    return text;
  }

  if (!/^[ \t]*import pwd[ \t]*$/m.test(text)) {
    throw new Error('searx/valkeydb.py 结构不符合预期：未找到顶层 `import pwd`');
  }

  let out = text.replace(
    /^([ \t]*)import pwd[ \t]*$/m,
    [
      'try:',
      '    import pwd',
      IMPORT_MARKER,
      '    pwd = None',
    ].join('\n'),
  );

  const branchPattern =
    /^([ \t]*)_pw = pwd\.getpwuid\(os\.getuid\(\)\)[ \t]*\r?\n([ \t]*)logger\.exception\("\[%s \(%s\)\] can't connect valkey DB \.\.\.", _pw\.pw_name, _pw\.pw_uid\)[ \t]*$/m;

  if (!branchPattern.test(out)) {
    throw new Error(
      'searx/valkeydb.py 结构不符合预期：未找到 `pwd.getpwuid(os.getuid())` 日志分支',
    );
  }

  out = out.replace(branchPattern, (match, indent, logIndent) =>
    [
      `${indent}if pwd is not None:`,
      `${indent}    _pw = pwd.getpwuid(os.getuid())`,
      `${indent}    _user, _uid = _pw.pw_name, _pw.pw_uid`,
      `${indent}else:  # Windows 没有 pwd / getuid`,
      `${indent}    _user = os.environ.get("USERNAME", "unknown")`,
      `${indent}    _uid = os.getpid()`,
      `${logIndent}logger.exception("[%s (%s)] can't connect valkey DB ...", _user, _uid)`,
    ].join('\n'),
  );

  // 二次确认：补丁后应能通过标记检测
  if (!out.includes(IMPORT_MARKER) || !out.includes(GUARD_MARKER)) {
    throw new Error('searx/valkeydb.py 补丁失败：替换结果缺少预期标记');
  }
  return out;
}

/** 对 valkeydb.py 文件就地打补丁；返回是否发生了修改。 */
export async function patchValkeyDbFile(file, logger) {
  const original = await fs.readFile(file, 'utf8');
  const patched = patchValkeyDb(original);
  if (patched === original) {
    logger?.('valkeydb.py 已包含 Windows 补丁，跳过');
    return false;
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, patched, 'utf8');
  await fs.rename(tmp, file);
  logger?.('已给 searx/valkeydb.py 打 Windows pwd 补丁');
  return true;
}

// ---------------------------------------------------------------------------
// 最小 ZIP 读取器
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Windows 文件名非法字符（含控制字符） */
const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function decodeName(buffer) {
  return buffer.toString('utf8');
}

function findEndOfCentralDirectory(buf) {
  const minOffset = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return i;
    }
  }
  throw new Error('不是有效的 ZIP 文件：未找到 End of Central Directory');
}

function readCentralDirectory(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || totalEntries === 0xffff) {
    throw new Error('暂不支持 ZIP64 格式的源码包');
  }
  if (cdOffset >= buf.length) {
    throw new Error('ZIP 文件已损坏：中央目录偏移越界');
  }

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error(`ZIP 文件已损坏：第 ${i + 1} 个中央目录项无效`);
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = decodeName(buf.subarray(offset + 46, offset + 46 + nameLen));

    entries.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      externalAttrs,
      localOffset,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf, entry) {
  const local = entry.localOffset;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) {
    throw new Error(`ZIP 文件已损坏：条目 ${entry.name} 的本地头无效`);
  }
  if (entry.flags & 0x1) {
    throw new Error(`ZIP 条目已加密，无法解压：${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) {
    throw new Error(`ZIP 文件已损坏：条目 ${entry.name} 数据越界`);
  }
  const raw = buf.subarray(start, end);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}（条目 ${entry.name}）`);
}

// CRC32 表（ZIP 使用标准 CRC-32/ISO-HDLC）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isWindowsInvalidName(name) {
  const parts = name.split('/');
  for (const part of parts) {
    if (!part) continue;
    if (WINDOWS_INVALID_CHARS.test(part)) return true;
    if (/[. ]$/.test(part)) return true;
    if (WINDOWS_RESERVED.test(part)) return true;
  }
  return false;
}

function resolveEntryPath(destDir, name, stripComponents) {
  const normalized = name.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new Error(`ZIP 条目路径越界（包含 ..）：${name}`);
  }
  const stripped = parts.slice(stripComponents);
  if (stripped.length === 0) return null;

  const target = path.resolve(destDir, ...stripped);
  const relative = path.relative(path.resolve(destDir), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`ZIP 条目路径越界：${name}`);
  }
  return target;
}

/**
 * 解压 ZIP；可选择跳过 Windows 非法文件名。
 *
 * @param {string} zipPath ZIP 路径
 * @param {string} destDir 解压目标目录
 * @param {{ stripComponents?: number, skipInvalid?: boolean, logger?: (msg:string)=>void }} [options]
 * @returns {Promise<{ extracted: number, skipped: Array<{name:string, reason:string}>, total: number }>}
 */
export async function unpackZip(zipPath, destDir, options = {}) {
  const stripComponents = Math.max(0, options.stripComponents || 0);
  const skipInvalid = options.skipInvalid !== false;
  const logger = options.logger;
  const buf = await fs.readFile(zipPath);
  const entries = readCentralDirectory(buf);
  const destRoot = path.resolve(destDir);
  await fs.mkdir(destRoot, { recursive: true });

  const skipped = [];
  let extracted = 0;

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (skipInvalid && isWindowsInvalidName(name)) {
      skipped.push({ name: entry.name, reason: '文件名含 Windows 非法字符' });
      continue;
    }
    // 跳过符号链接（源码包不需要，且跨平台风险高）
    const unixMode = (entry.externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      skipped.push({ name: entry.name, reason: '符号链接' });
      continue;
    }

    if (name.endsWith('/')) {
      if (name.split('/').filter(Boolean).length > stripComponents) {
        const dir = resolveEntryPath(destRoot, name, stripComponents);
        if (dir) await fs.mkdir(dir, { recursive: true });
      }
      continue;
    }

    const target = resolveEntryPath(destRoot, name, stripComponents);
    if (!target) continue;

    const data = readEntryData(buf, entry);
    if (data.length !== entry.uncompressedSize) {
      throw new Error(
        `ZIP 条目大小不符（${entry.name}）：期望 ${entry.uncompressedSize}，实际 ${data.length}`,
      );
    }
    if (crc32(data) !== entry.crc >>> 0) {
      throw new Error(`ZIP 条目 CRC 校验失败：${entry.name}`);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    if (unixMode && (unixMode & 0o111)) {
      await fs.chmod(target, 0o755).catch(() => {});
    }
    extracted += 1;
  }

  if (skipped.length > 0) {
    logger?.(`已跳过 ${skipped.length} 个不兼容条目（Windows 非法文件名 / 符号链接）`);
  }
  return { extracted, skipped, total: entries.length };
}

/**
 * 解压 ZIP 并在 Windows 上跳过含 `:` 等非法字符的条目。
 * 这是给 Windows 安装流程用的便捷包装。
 */
export async function unpackZipSkippingInvalid(zipPath, destDir, options = {}) {
  return unpackZip(zipPath, destDir, { ...options, skipInvalid: true });
}
