/**
 * agent_search_gateway 用户级自启服务安装器（跨平台共享实现）
 *
 * 由一键安装器调用，把 scripts/start-all.mjs 注册为当前用户登录后自动启动的前台
 * supervisor：
 *   - Linux：systemd --user 单元 ~/.config/systemd/user/agent-search-gateway.service
 *   - macOS：LaunchAgent ~/Library/LaunchAgents/com.djasdh.agent-search-gateway.plist
 *   - Windows：登录计划任务 AgentSearchGateway，调用 scripts/start-all.ps1
 *
 * 导出：
 *   installService({ root, platform, nodePath, logger })
 *   uninstallService({ platform, logger })
 *   serviceStatus({ platform, logger })
 *
 * 额外可选参数 dryRun=true 时只生成文件并打印将要执行的命令，不调用
 * systemctl / launchctl / schtasks，便于测试或在受限环境中预演。
 *
 * 所有子进程命令都使用参数数组传递，含空格的路径无需手工拼引号；写入
 * systemd 单元、LaunchAgent plist 与计划任务命令时再按各自语法加引号。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PS1 = path.resolve(HERE, '..', 'start-all.ps1');

const SERVICE_NAME = 'agent-search-gateway';
const SYSTEMD_UNIT_NAME = `${SERVICE_NAME}.service`;
const MACOS_LABEL = 'com.djasdh.agent-search-gateway';
const WINDOWS_TASK_NAME = 'AgentSearchGateway';

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function normalizePlatform(platform) {
  const value = String(platform || process.platform).toLowerCase();
  if (value === 'linux' || value.startsWith('linux-')) return 'linux';
  if (
    value === 'darwin' ||
    value === 'mac' ||
    value === 'macos' ||
    value.startsWith('darwin-') ||
    value.startsWith('macos-')
  ) {
    return 'darwin';
  }
  if (value === 'win32' || value === 'windows' || value.startsWith('win32-')) return 'win32';
  throw new Error(`不支持的操作系统：${value}（仅支持 linux / darwin / win32）`);
}

function createLogger(logger) {
  const pick = (level, fallback) => {
    if (typeof logger === 'function') return (...args) => logger(...args);
    if (logger && typeof logger[level] === 'function') {
      return (...args) => logger[level](...args);
    }
    if (logger && typeof logger.log === 'function') return (...args) => logger.log(...args);
    return fallback;
  };
  return {
    info: pick('info', (...args) => console.log(...args)),
    warn: pick('warn', (...args) => console.warn(...args)),
    error: pick('error', (...args) => console.error(...args)),
  };
}

function quoteForDisplay(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function formatCommand(command, args) {
  return [command, ...args].map(quoteForDisplay).join(' ');
}

function execute(command, args, options = {}) {
  const {
    dryRun = false,
    allowFailure = false,
    logger,
    cwd,
    env,
    timeout = 30_000,
  } = options;
  const display = formatCommand(command, args);

  if (dryRun) {
    if (logger) logger.info(`[dry-run] ${display}`);
    return { status: 0, stdout: '', stderr: '', dryRun: true };
  }

  const result = spawnSync(command, args, {
    cwd,
    env: env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
  });

  if (result.error) {
    if (!allowFailure) {
      throw new Error(`无法执行 ${command}：${result.error.message}`);
    }
    return result;
  }

  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `命令执行失败（退出码 ${result.status}）：${display}${detail ? `\n${detail}` : ''}`,
    );
  }

  return result;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function homeDir() {
  return os.homedir();
}

function resolveRoot(root) {
  if (!root || typeof root !== 'string') {
    throw new Error('installService 缺少 root 参数（项目根目录）');
  }
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`项目根目录不存在：${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`项目根路径不是目录：${resolved}`);
  }
  return resolved;
}

function resolveNodePath(nodePath, log) {
  if (!nodePath || typeof nodePath !== 'string') {
    log.warn(`未提供 nodePath，使用当前 Node：${process.execPath}`);
    return process.execPath;
  }
  if (!path.isAbsolute(nodePath)) {
    log.warn(`nodePath 不是绝对路径：${nodePath}，服务启动时可能找不到 node`);
  }
  return nodePath;
}

function startAllPathFor(root) {
  const startAllPath = path.join(root, 'scripts', 'start-all.mjs');
  if (!fs.existsSync(startAllPath)) {
    throw new Error(`安装包不完整，未找到 ${startAllPath}`);
  }
  return startAllPath;
}

// ---------------------------------------------------------------------------
// Linux / systemd --user
// ---------------------------------------------------------------------------

function systemdQuote(value, { exec = false } = {}) {
  let text = String(value)
    .replace(/%/g, '%%')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  if (exec) {
    // systemd 命令行的 $ 会被当作环境变量展开，写成 $$ 表示字面量。
    text = text.replace(/\$/g, '$$$$');
  }
  return `"${text}"`;
}

function renderSystemdUnit({ root, nodePath, startAllPath }) {
  return `[Unit]
Description=Agent Search Gateway（searxng / flaresolverr / gateway）
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(root)}
ExecStart=${systemdQuote(nodePath, { exec: true })} ${systemdQuote(startAllPath, { exec: true })}
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

function systemdUnitPath() {
  return path.join(homeDir(), '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

function checkSystemdUser(log) {
  const result = execute('systemctl', ['--user', 'show-environment'], {
    allowFailure: true,
    logger: log,
    timeout: 10_000,
  });
  if (result.error) {
    return { ok: false, detail: `无法执行 systemctl：${result.error.message}` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `退出码 ${result.status}`;
    return { ok: false, detail };
  }
  return { ok: true };
}

function systemdManualHint(unitPath) {
  return [
    '请手动执行：',
    `  systemctl --user daemon-reload`,
    `  systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
    `  systemctl --user status ${SYSTEMD_UNIT_NAME}`,
    `  journalctl --user -u ${SYSTEMD_UNIT_NAME} -f`,
    `单元文件：${unitPath}`,
  ].join('\n');
}

async function installLinux({ root, nodePath, log, dryRun }) {
  const startAllPath = startAllPathFor(root);
  const unitPath = systemdUnitPath();
  ensureDir(path.dirname(unitPath));

  fs.writeFileSync(unitPath, renderSystemdUnit({ root, nodePath, startAllPath }), {
    encoding: 'utf8',
    mode: 0o644,
  });
  fs.chmodSync(unitPath, 0o644);
  log.info(`${dryRun ? '[dry-run] ' : ''}已写入 systemd 用户单元：${unitPath}`);

  const availability = dryRun ? { ok: true } : checkSystemdUser(log);
  if (!availability.ok) {
    throw new Error(
      `systemd --user 不可用：${availability.detail}\n${systemdManualHint(unitPath)}`,
    );
  }

  try {
    execute('systemctl', ['--user', 'daemon-reload'], { dryRun, logger: log });
    execute('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME], {
      dryRun,
      logger: log,
    });
  } catch (error) {
    throw new Error(`${error.message}\n${systemdManualHint(unitPath)}`);
  }

  log.info(`${dryRun ? '[dry-run] ' : ''}已启用并启动 systemd 用户服务：${SYSTEMD_UNIT_NAME}`);
  return {
    platform: 'linux',
    method: 'systemd-user',
    path: unitPath,
    unitPath,
    enabled: dryRun ? null : true,
    active: dryRun ? null : true,
    dryRun,
  };
}

async function uninstallLinux({ log, dryRun }) {
  const unitPath = systemdUnitPath();
  const availability = dryRun ? { ok: true } : checkSystemdUser(log);

  if (availability.ok) {
    execute('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME], {
      dryRun,
      allowFailure: true,
      logger: log,
    });
  } else {
    log.warn(`systemd --user 不可用（${availability.detail}），仅删除单元文件`);
  }

  let removed = false;
  if (fs.existsSync(unitPath)) {
    if (dryRun) {
      log.info(`[dry-run] 删除 ${unitPath}`);
    } else {
      fs.rmSync(unitPath, { force: true });
      removed = true;
      log.info(`已删除 systemd 用户单元：${unitPath}`);
    }
  } else {
    log.info(`未找到 systemd 用户单元：${unitPath}`);
  }

  if (availability.ok) {
    execute('systemctl', ['--user', 'daemon-reload'], {
      dryRun,
      allowFailure: true,
      logger: log,
    });
  }

  log.info(`${dryRun ? '[dry-run] ' : ''}已卸载 systemd 用户服务`);
  return {
    platform: 'linux',
    method: 'systemd-user',
    path: unitPath,
    removed,
    dryRun,
  };
}

async function statusLinux({ log, dryRun }) {
  const unitPath = systemdUnitPath();
  const installed = fs.existsSync(unitPath);

  if (dryRun) {
    log.info(`[dry-run] 单元文件：${unitPath}（${installed ? '存在' : '不存在'}）`);
    return {
      platform: 'linux',
      method: 'systemd-user',
      path: unitPath,
      unitPath,
      installed,
      enabled: null,
      active: null,
      dryRun,
    };
  }

  const availability = checkSystemdUser(log);
  let enabled = installed ? 'unknown' : 'not-found';
  let active = 'unknown';

  if (!availability.ok) {
    log.warn(`systemd --user 不可用：${availability.detail}`);
  } else {
    const enabledResult = execute('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT_NAME], {
      allowFailure: true,
      logger: log,
    });
    const activeResult = execute('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME], {
      allowFailure: true,
      logger: log,
    });
    const enabledText = (enabledResult.stdout || enabledResult.stderr || '').trim().split('\n')[0];
    const activeText = (activeResult.stdout || activeResult.stderr || '').trim().split('\n')[0];
    if (installed && enabledText) enabled = enabledText;
    if (installed && activeText) active = activeText;
    if (!installed) active = 'inactive';
  }

  log.info(`单元文件：${unitPath}（${installed ? '存在' : '不存在'}）`);
  log.info(`启用状态：${enabled}`);
  log.info(`运行状态：${active}`);

  return {
    platform: 'linux',
    method: 'systemd-user',
    path: unitPath,
    unitPath,
    installed,
    enabled,
    active,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// macOS / LaunchAgent
// ---------------------------------------------------------------------------

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function macosPlistPath() {
  return path.join(homeDir(), 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`);
}

function macosLogPaths() {
  const logDir = path.join(homeDir(), 'Library', 'Logs');
  return {
    logDir,
    stdout: path.join(logDir, `${SERVICE_NAME}.out.log`),
    stderr: path.join(logDir, `${SERVICE_NAME}.err.log`),
  };
}

function renderMacosPlist({ root, nodePath, startAllPath }) {
  const logs = macosLogPaths();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(startAllPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logs.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logs.stderr)}</string>
</dict>
</plist>
`;
}

function currentUid() {
  if (typeof process.getuid === 'function') return process.getuid();
  const result = execute('id', ['-u'], { allowFailure: true });
  return (result.stdout || '').trim() || '501';
}

async function installMacos({ root, nodePath, log, dryRun }) {
  const startAllPath = startAllPathFor(root);
  const plistPath = macosPlistPath();
  const logs = macosLogPaths();
  ensureDir(path.dirname(plistPath));
  ensureDir(logs.logDir);

  fs.writeFileSync(plistPath, renderMacosPlist({ root, nodePath, startAllPath }), {
    encoding: 'utf8',
    mode: 0o644,
  });
  fs.chmodSync(plistPath, 0o644);
  log.info(`${dryRun ? '[dry-run] ' : ''}已写入 LaunchAgent：${plistPath}`);
  log.info(`服务日志：${logs.stdout} / ${logs.stderr}`);

  const domain = `gui/${currentUid()}`;

  // 先尝试卸载旧实例；未加载时 bootout 会失败，忽略即可。
  execute('launchctl', ['bootout', domain, plistPath], {
    dryRun,
    allowFailure: true,
    logger: log,
  });

  const bootstrap = execute('launchctl', ['bootstrap', domain, plistPath], {
    dryRun,
    allowFailure: true,
    logger: log,
  });

  if (!dryRun && bootstrap.status !== 0) {
    const detail = (bootstrap.stderr || bootstrap.stdout || '').trim();
    log.warn(`launchctl bootstrap 失败，回退到旧版 unload/load${detail ? `：${detail}` : ''}`);
    execute('launchctl', ['unload', plistPath], {
      allowFailure: true,
      logger: log,
    });
    const loaded = execute('launchctl', ['load', '-w', plistPath], {
      allowFailure: true,
      logger: log,
    });
    if (loaded.status !== 0) {
      const loadDetail = (loaded.stderr || loaded.stdout || '').trim();
      throw new Error(
        `launchctl 加载 LaunchAgent 失败${loadDetail ? `：${loadDetail}` : ''}\n` +
          `请手动执行：\n  launchctl bootout ${domain} "${plistPath}"\n  launchctl bootstrap ${domain} "${plistPath}"\n` +
          `或：\n  launchctl unload "${plistPath}"\n  launchctl load -w "${plistPath}"`,
      );
    }
  }

  log.info(`${dryRun ? '[dry-run] ' : ''}已加载 LaunchAgent：${MACOS_LABEL}`);
  return {
    platform: 'darwin',
    method: 'launchd',
    path: plistPath,
    plistPath,
    label: MACOS_LABEL,
    loaded: dryRun ? null : true,
    dryRun,
  };
}

async function uninstallMacos({ log, dryRun }) {
  const plistPath = macosPlistPath();
  const domain = `gui/${currentUid()}`;

  const bootout = execute('launchctl', ['bootout', domain, plistPath], {
    dryRun,
    allowFailure: true,
    logger: log,
  });
  if (!dryRun && bootout.status !== 0) {
    execute('launchctl', ['unload', plistPath], {
      allowFailure: true,
      logger: log,
    });
  }

  let removed = false;
  if (fs.existsSync(plistPath)) {
    if (dryRun) {
      log.info(`[dry-run] 删除 ${plistPath}`);
    } else {
      fs.rmSync(plistPath, { force: true });
      removed = true;
      log.info(`已删除 LaunchAgent：${plistPath}`);
    }
  } else {
    log.info(`未找到 LaunchAgent：${plistPath}`);
  }

  log.info(`${dryRun ? '[dry-run] ' : ''}已卸载 LaunchAgent 服务`);
  return {
    platform: 'darwin',
    method: 'launchd',
    path: plistPath,
    plistPath,
    removed,
    dryRun,
  };
}

async function statusMacos({ log, dryRun }) {
  const plistPath = macosPlistPath();
  const installed = fs.existsSync(plistPath);

  if (dryRun) {
    log.info(`[dry-run] LaunchAgent：${plistPath}（${installed ? '存在' : '不存在'}）`);
    return {
      platform: 'darwin',
      method: 'launchd',
      path: plistPath,
      plistPath,
      label: MACOS_LABEL,
      installed,
      loaded: null,
      dryRun,
    };
  }

  const domain = `gui/${currentUid()}`;
  let loaded = false;
  let stateText = 'unknown';
  let pid = null;

  const printed = execute('launchctl', ['print', `${domain}/${MACOS_LABEL}`], {
    allowFailure: true,
    logger: log,
  });
  if (printed.status === 0) {
    loaded = true;
    const output = printed.stdout || '';
    const stateMatch = output.match(/state = ([^\n]+)/);
    const pidMatch = output.match(/pid = (\d+)/);
    if (stateMatch) stateText = stateMatch[1].trim();
    if (pidMatch) pid = Number(pidMatch[1]);
  } else {
    const listed = execute('launchctl', ['list', MACOS_LABEL], {
      allowFailure: true,
      logger: log,
    });
    if (listed.status === 0) {
      loaded = true;
      stateText = 'loaded';
    }
  }

  log.info(`LaunchAgent 文件：${plistPath}（${installed ? '存在' : '不存在'}）`);
  log.info(`加载状态：${loaded ? '已加载' : '未加载'}（${stateText}）`);
  if (pid) log.info(`进程 PID：${pid}`);

  return {
    platform: 'darwin',
    method: 'launchd',
    path: plistPath,
    plistPath,
    label: MACOS_LABEL,
    installed,
    loaded,
    state: stateText,
    pid,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Windows / 登录计划任务
// ---------------------------------------------------------------------------

const WINDOWS_PS1_FALLBACK = `# agent_search_gateway 前台 supervisor 的 Windows 薄包装
# 由登录计划任务调用，也可手动运行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\start-all.ps1
# 参数会原样传给 start-all.mjs，例如 --check / --help。
$ErrorActionPreference = "Stop"

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $PSScriptRoot
$StartAll = Join-Path $Root "scripts\\start-all.mjs"

function Find-NodeJs {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        if ($cmd.Path) { return $cmd.Path }
        if ($cmd.Source) { return $cmd.Source }
    }
    $toolDir = Join-Path $Root "data\\toolchain\\node"
    if (Test-Path $toolDir) {
        $exe = Get-ChildItem -Path $toolDir -Filter node.exe -Recurse -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($exe) { return $exe.FullName }
    }
    return $null
}

if (-not (Test-Path $StartAll)) {
    Write-Host "[start-all] 未找到 $StartAll"
    exit 1
}

$Node = Find-NodeJs
if (-not $Node) {
    Write-Host "[start-all] PATH 中未找到 node，请先安装 Node.js LTS：https://nodejs.org/zh-cn/download"
    exit 1
}

& $Node $StartAll @args
exit $LASTEXITCODE
`;

function windowsScriptPath(root) {
  return path.join(root, 'scripts', 'start-all.ps1');
}

function ensureWindowsWrapper(root, log, dryRun) {
  const target = windowsScriptPath(root);
  ensureDir(path.dirname(target));

  const fallback = Buffer.from(WINDOWS_PS1_FALLBACK, 'utf8');
  const source = fs.existsSync(SOURCE_PS1) ? fs.readFileSync(SOURCE_PS1) : fallback;
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

  let content = null;
  let action = '';

  if (!fs.existsSync(target)) {
    content = source;
    action = '生成';
  } else {
    const current = fs.readFileSync(target);
    if (current.length === 0) {
      content = source;
      action = '重新生成（原文件为空）';
    } else if (!(current[0] === 0xef && current[1] === 0xbb && current[2] === 0xbf)) {
      content = current;
      action = '补充 UTF-8 BOM';
    }
  }

  if (!content) {
    log.info(`启动脚本已存在：${target}`);
    return target;
  }

  const normalized = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
    ? content
    : Buffer.concat([BOM, content]);

  fs.writeFileSync(target, normalized, { mode: 0o644 });
  log.info(`${dryRun ? '[dry-run] ' : ''}已${action}：${target}`);
  return target;
}

function windowsTaskCommand(scriptPath) {
  // 含空格的路径用双引号包住；Windows 路径不能包含双引号，无需再转义。
  return `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`;
}

async function installWindows({ root, nodePath, log, dryRun }) {
  startAllPathFor(root);
  const scriptPath = ensureWindowsWrapper(root, log, dryRun);
  const taskCommand = windowsTaskCommand(scriptPath);
  void nodePath; // Windows 由 start-all.ps1 自行查找 node；任务命令使用 powershell。

  const args = [
    '/create',
    '/tn',
    WINDOWS_TASK_NAME,
    '/sc',
    'onlogon',
    '/tr',
    taskCommand,
    '/f',
  ];

  try {
    execute('schtasks', args, { dryRun, logger: log });
  } catch (error) {
    throw new Error(
      `${error.message}\n` +
        `请以管理员身份打开 PowerShell 手动执行：\n` +
        `  schtasks /create /tn ${WINDOWS_TASK_NAME} /sc onlogon /tr "${taskCommand}" /f`,
    );
  }

  log.info(`${dryRun ? '[dry-run] ' : ''}已注册登录计划任务：${WINDOWS_TASK_NAME}`);
  log.info(`任务命令：${taskCommand}`);
  return {
    platform: 'win32',
    method: 'schtasks',
    path: scriptPath,
    scriptPath,
    taskName: WINDOWS_TASK_NAME,
    taskCommand,
    registered: dryRun ? null : true,
    dryRun,
  };
}

async function uninstallWindows({ log, dryRun }) {
  if (dryRun) {
    log.info(`[dry-run] schtasks /delete /tn ${WINDOWS_TASK_NAME} /f`);
    return {
      platform: 'win32',
      method: 'schtasks',
      taskName: WINDOWS_TASK_NAME,
      removed: false,
      dryRun,
    };
  }

  const query = execute('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME], {
    allowFailure: true,
    logger: log,
  });
  if (query.status !== 0) {
    log.info(`计划任务未注册：${WINDOWS_TASK_NAME}`);
    return {
      platform: 'win32',
      method: 'schtasks',
      taskName: WINDOWS_TASK_NAME,
      removed: false,
      dryRun,
    };
  }

  const deleted = execute('schtasks', ['/delete', '/tn', WINDOWS_TASK_NAME, '/f'], {
    allowFailure: true,
    logger: log,
  });
  if (deleted.status !== 0) {
    const detail = (deleted.stderr || deleted.stdout || '').trim();
    throw new Error(
      `删除计划任务失败${detail ? `：${detail}` : ''}\n` +
        `请以管理员身份打开 PowerShell 手动执行：\n  schtasks /delete /tn ${WINDOWS_TASK_NAME} /f`,
    );
  }

  log.info(`已删除登录计划任务：${WINDOWS_TASK_NAME}`);
  return {
    platform: 'win32',
    method: 'schtasks',
    taskName: WINDOWS_TASK_NAME,
    removed: true,
    dryRun,
  };
}

async function statusWindows({ log, dryRun }) {
  if (dryRun) {
    log.info(`[dry-run] schtasks /query /tn ${WINDOWS_TASK_NAME}`);
    return {
      platform: 'win32',
      method: 'schtasks',
      taskName: WINDOWS_TASK_NAME,
      installed: null,
      dryRun,
    };
  }

  const result = execute(
    'schtasks',
    ['/query', '/tn', WINDOWS_TASK_NAME, '/fo', 'LIST'],
    { allowFailure: true, logger: log },
  );
  const installed = result.status === 0;

  log.info(`计划任务：${WINDOWS_TASK_NAME}（${installed ? '已注册' : '未注册'}）`);
  if (installed && result.stdout) {
    const statusLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^(Status|状态)[:：]/i.test(line));
    if (statusLine) log.info(statusLine);
  }

  return {
    platform: 'win32',
    method: 'schtasks',
    taskName: WINDOWS_TASK_NAME,
    installed,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export async function installService({
  root,
  platform,
  nodePath,
  logger,
  dryRun = false,
} = {}) {
  const log = createLogger(logger);
  const target = normalizePlatform(platform);
  const resolvedRoot = resolveRoot(root);
  const resolvedNode = resolveNodePath(nodePath, log);

  if (target === 'linux') {
    return installLinux({ root: resolvedRoot, nodePath: resolvedNode, log, dryRun });
  }
  if (target === 'darwin') {
    return installMacos({ root: resolvedRoot, nodePath: resolvedNode, log, dryRun });
  }
  return installWindows({ root: resolvedRoot, nodePath: resolvedNode, log, dryRun });
}

export async function uninstallService({ platform, logger, dryRun = false } = {}) {
  const log = createLogger(logger);
  const target = normalizePlatform(platform);

  if (target === 'linux') return uninstallLinux({ log, dryRun });
  if (target === 'darwin') return uninstallMacos({ log, dryRun });
  return uninstallWindows({ log, dryRun });
}

export async function serviceStatus({ platform, logger, dryRun = false } = {}) {
  const log = createLogger(logger);
  const target = normalizePlatform(platform);

  if (target === 'linux') return statusLinux({ log, dryRun });
  if (target === 'darwin') return statusMacos({ log, dryRun });
  return statusWindows({ log, dryRun });
}
