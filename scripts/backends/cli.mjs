#!/usr/bin/env node
/**
 * agent_search_gateway 后端安装管理 CLI
 *
 * 用法：
 *   node scripts/backends/cli.mjs <后端> [install|update|status|uninstall]
 *
 * 后端：bili | ytdlp | opencli | article
 * 默认子命令为 install。
 *
 * 约定：
 *   - 安装目录：仓库根 data/backends/<后端>/（article 使用 article-server）
 *   - 版本记录：data/backends/<后端>/version.json
 *   - 首次安装把原配置值备份到 data/backends/<后端>/previous.json
 *   - 配置文件：$GATEWAY_CONFIG_FILE，缺省为仓库根 gateway.yaml
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseDocument, YAMLSeq } from "yaml";

const IS_WIN = process.platform === "win32";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKENDS_DIR = path.join(ROOT, "data", "backends");
const CONFIG_PATH = process.env.GATEWAY_CONFIG_FILE
  ? path.resolve(process.env.GATEWAY_CONFIG_FILE)
  : path.join(ROOT, "gateway.yaml");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const USER_AGENT = "agent-search-gateway-backend-cli";

const DEFAULT_ARTICLE_PORT = 8010;

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function log(name, message) {
  console.log(`[${name}] ${message}`);
}

function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: "inherit",
    shell: Boolean(options.shell),
    env: process.env,
  });
  if (result.error) {
    throw new Error(`无法执行 ${command}：${result.error.message}`);
  }
  if (result.status !== 0) {
    const code = result.status === null ? `信号 ${result.signal}` : `退出码 ${result.status}`;
    throw new Error(`命令执行失败（${code}）：${command} ${args.join(" ")}`);
  }
  void name;
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) {
    throw new Error(`无法执行 ${command}：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`命令执行失败（退出码 ${result.status}）：${command} ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout;
}

function findPython(name) {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
  const seen = new Set();
  let firstFound = null;

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const probe = spawnSync(
      candidate,
      ["-c", 'import sys; print("%d.%d" % sys.version_info[:2]); raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'],
      { encoding: "utf8" },
    );
    if (probe.error) continue;
    const detected = (probe.stdout || "").trim();
    if (!firstFound) firstFound = { command: candidate, version: detected };
    if (probe.status === 0) {
      log(name, `使用 Python ${detected}（${candidate}）`);
      return candidate;
    }
  }

  if (firstFound) {
    throw new Error(
      `找到 ${firstFound.command}（Python ${firstFound.version}），但需要 Python >= 3.10。请升级：https://www.python.org/downloads/`,
    );
  }
  throw new Error("未找到 Python 3.10+。请先安装：https://www.python.org/downloads/");
}

function venvPythonPath(venvDir) {
  return IS_WIN
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function venvBinPath(venvDir, name) {
  return IS_WIN
    ? path.join(venvDir, "Scripts", `${name}.exe`)
    : path.join(venvDir, "bin", name);
}

function pipShowVersion(name, python, packageName) {
  const output = capture(python, ["-m", "pip", "show", packageName]);
  const match = output.match(/^Version:\s*(.+)$/m);
  if (!match) {
    throw new Error(`无法解析 ${packageName} 版本（pip show 输出中未找到 Version）`);
  }
  void name;
  return match[1].trim();
}

function nodeVersionAtLeast(actual, required) {
  const parse = (value) => String(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(actual);
  const b = parse(required);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

/**
 * 优先用当前 Node 自带的 npm-cli.js 执行 npm，避免 Windows 上 .cmd 需要 shell
 * 以及安装路径含空格时的转义问题；找不到时回落到 PATH 里的 npm。
 */
function resolveNpm() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: process.execPath, argsPrefix: [candidate], shell: false };
    }
  }
  return {
    command: IS_WIN ? "npm.cmd" : "npm",
    argsPrefix: [],
    shell: IS_WIN,
  };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifySha256(name, file, sumsText, expectedName) {
  let expected = null;
  for (const rawLine of sumsText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2].trim() === expectedName) {
      expected = match[1].toLowerCase();
      break;
    }
  }
  if (!expected) {
    throw new Error(`校验文件中没有 ${expectedName} 的 SHA256 记录`);
  }
  const actual = await sha256File(file);
  if (actual !== expected) {
    throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}（文件：${file}）`);
  }
  log(name, `SHA256 校验通过：${expectedName}`);
}

function githubHeaders(accept) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: accept || "application/vnd.github+json",
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

/**
 * Release 资产下载地址。
 *
 * 优先使用 API 资产地址（参数 Accept: application/octet-stream，由 GitHub 重定向到
 * 签名下载地址），这样私有仓库也能带 GITHUB_TOKEN 下载；缺失时回落到
 * browser_download_url。
 */
function releaseAssetUrl(asset) {
  return asset.url || asset.browser_download_url;
}

async function fetchWithContext(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const cause = error && error.cause
      ? error.cause.message || error.cause.code || String(error.cause)
      : "";
    const detail = cause ? `（${cause}）` : "";
    throw new Error(`网络请求失败${detail}：${url}`);
  }
}

async function githubLatestRelease(name, repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await fetchWithContext(url, { headers: githubHeaders() });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`未找到 ${repo} 的最新 Release（HTTP 404），仓库或发布可能尚不存在`);
    }
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        `GitHub API 限流（HTTP ${response.status}）。请设置环境变量 GITHUB_TOKEN 后重试`,
      );
    }
    throw new Error(`获取 ${repo} 最新 Release 失败：HTTP ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data || !data.tag_name) {
    throw new Error(`获取 ${repo} 最新 Release 失败：响应中没有 tag_name`);
  }
  log(name, `最新 Release：${data.tag_name}`);
  return data;
}

async function fetchText(name, url, displayName) {
  assertHttpsUrl(url);
  const temporary = path.join(
    os.tmpdir(),
    `asg-text-${process.pid}-${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  try {
    await downloadFile(name, url, temporary, displayName || "校验文件");
    return fs.readFileSync(temporary, "utf8");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

function hasProxyEnv() {
  return PROXY_ENV_KEYS.some((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

function assertHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`下载地址不合法：${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`出于安全考虑，仅允许 https 下载：${url}`);
  }
}

async function fetchToFile(url, destination) {
  const response = await fetchWithContext(url, {
    headers: githubHeaders("application/octet-stream"),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  }
  if (!response.body) {
    throw new Error(`下载失败：响应没有内容（${url}）`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

async function downloadFile(name, url, destination, displayName) {
  assertHttpsUrl(url);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const label = displayName || path.basename(destination);
  const partFile = path.join(
    path.dirname(destination),
    `.asg-download-${process.pid}-${crypto.randomBytes(4).toString("hex")}.part`,
  );
  const proxyConfigured = hasProxyEnv();
  const errors = [];

  const tryTool = (command, args, toolLabel) => {
    fs.rmSync(partFile, { force: true });
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (result.error) {
      if (result.error.code === "ENOENT") {
        errors.push(`${toolLabel}: 未找到`);
        return "missing";
      }
      errors.push(`${toolLabel}: ${result.error.message}`);
      return "failed";
    }
    if (result.status !== 0) {
      const detail = (result.stderr || "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join(" ");
      errors.push(`${toolLabel}: 退出码 ${result.status}${detail ? `（${detail}）` : ""}`);
      fs.rmSync(partFile, { force: true });
      return "failed";
    }
    if (!fs.existsSync(partFile) || fs.statSync(partFile).size === 0) {
      errors.push(`${toolLabel}: 下载结果为空`);
      fs.rmSync(partFile, { force: true });
      return "failed";
    }
    return "ok";
  };

  const tryCurl = () =>
    tryTool(
      "curl",
      [
        "-fsSL",
        "-H",
        "Accept: application/octet-stream",
        "--retry",
        "3",
        "--connect-timeout",
        "20",
        "--output",
        partFile,
        url,
      ],
      "curl",
    );

  const tryWget = () =>
    tryTool(
      "wget",
      [
        "-q",
        "--header=Accept: application/octet-stream",
        "--tries=3",
        "--timeout=20",
        "-O",
        partFile,
        url,
      ],
      "wget",
    );

  const tryFetch = async () => {
    fs.rmSync(partFile, { force: true });
    try {
      await fetchToFile(url, partFile);
      if (!fs.existsSync(partFile) || fs.statSync(partFile).size === 0) {
        errors.push("Node fetch: 下载结果为空");
        fs.rmSync(partFile, { force: true });
        return "failed";
      }
      return "ok";
    } catch (error) {
      errors.push(`Node fetch: ${error.message}`);
      fs.rmSync(partFile, { force: true });
      return "failed";
    }
  };

  try {
    let success = false;

    if (proxyConfigured) {
      // 有代理环境变量时 curl/wget 会自动读取，优先走系统工具。
      const curlStatus = tryCurl();
      if (curlStatus === "ok") {
        success = true;
      } else if (curlStatus === "missing") {
        const wgetStatus = tryWget();
        success = wgetStatus === "ok";
      }
      if (!success) {
        success = (await tryFetch()) === "ok";
      }
    } else {
      // 没有代理环境变量时先直连，失败再回退系统工具。
      success = (await tryFetch()) === "ok";
      if (!success) {
        const curlStatus = tryCurl();
        if (curlStatus === "ok") {
          success = true;
        } else if (curlStatus === "missing") {
          const wgetStatus = tryWget();
          success = wgetStatus === "ok";
        }
      }
    }

    if (!success) {
      const hint = proxyConfigured
        ? "已检测到代理环境变量，但 curl/wget/Node fetch 均下载失败，请确认代理地址可用。"
        : "若在代理环境，请设置 HTTPS_PROXY（例如 http://127.0.0.1:7897）后重试。";
      throw new Error(
        `下载失败：${label}\n${errors.map((item) => `- ${item}`).join("\n")}\n${hint}`,
      );
    }

    const size = fs.statSync(partFile).size;
    try {
      fs.renameSync(partFile, destination);
    } catch (error) {
      if (!IS_WIN) throw error;
      // Windows 上 rename 不能覆盖已存在的目标文件。
      fs.rmSync(destination, { force: true });
      fs.renameSync(partFile, destination);
    }
    log(name, `下载完成：${label}（${formatBytes(size)}）`);
  } finally {
    fs.rmSync(partFile, { force: true });
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractTarGz(name, archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync("tar", ["-xzf", archive, "-C", destination], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`无法执行 tar（Windows 10+ 系统自带 tar.exe）：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`解压失败（tar 退出码 ${result.status}）：${archive}`);
  }
  log(name, `解压完成：${archive}`);
}

function findFileRoot(directory, fileName) {
  if (fs.existsSync(path.join(directory, fileName))) return directory;
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const matches = entries.filter((entry) => fs.existsSync(path.join(directory, entry.name, fileName)));
  if (matches.length === 1) return path.join(directory, matches[0].name);
  throw new Error(`压缩包内未找到 ${fileName}（可能打包结构不符合约定）`);
}

function copyDirectoryContents(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    fs.cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 配置读写（yaml Document API，保留注释与格式）
// ---------------------------------------------------------------------------

function loadConfigDocument({ create }) {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (!create) return null;
    const example = path.join(ROOT, "gateway.yaml.example");
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, CONFIG_PATH);
      console.log(`[配置] 未找到 ${CONFIG_PATH}，已从 gateway.yaml.example 创建`);
    } else {
      fs.writeFileSync(CONFIG_PATH, "{}\n", "utf8");
      console.log(`[配置] 未找到 ${CONFIG_PATH}，已创建空配置文件`);
    }
  }

  const text = fs.readFileSync(CONFIG_PATH, "utf8");
  const document = parseDocument(text);
  if (document.errors && document.errors.length > 0) {
    throw new Error(`配置文件语法错误（${CONFIG_PATH}）：${document.errors[0].message}`);
  }
  return document;
}

function saveConfigDocument(document) {
  fs.writeFileSync(CONFIG_PATH, document.toString(), "utf8");
}

/**
 * 写入单个配置项，并尽量保留原有注释。
 *
 * yaml 的 setIn 在替换标量时会保留行内注释，但替换数组时会丢掉；
 * 因此数组改为显式构造 YAMLSeq：非空数组用块格式（注释移到键所在行），
 * 空数组保持 flow 格式 `[]`（注释留在值所在行）。
 */
function setConfigValue(document, segments, value) {
  const parentSegments = segments.slice(0, -1);
  const key = segments[segments.length - 1];
  const existingValue = document.getIn(segments, true);
  const parent = parentSegments.length > 0
    ? document.getIn(parentSegments, true)
    : document.contents;
  const pair = parent && Array.isArray(parent.items)
    ? parent.items.find((item) => item && item.key && String(item.key.value) === key)
    : null;
  const keyNode = pair ? pair.key : null;

  if (!Array.isArray(value)) {
    document.setIn(segments, value);
    return;
  }

  const valueComment = existingValue && existingValue.comment;
  const valueCommentBefore = existingValue && existingValue.commentBefore;
  const keyComment = keyNode && keyNode.comment;
  const sequence = new YAMLSeq();
  sequence.items = value.map((item) => document.createNode(item));

  if (value.length === 0) {
    sequence.flow = true;
    const carriedComment = valueComment !== undefined
      ? valueComment
      : valueCommentBefore !== undefined
        ? valueCommentBefore
        : keyComment;
    if (carriedComment !== undefined) sequence.comment = carriedComment;
    if (keyComment !== undefined) keyNode.comment = undefined;
  } else {
    sequence.flow = false;
    const carriedComment = valueComment !== undefined ? valueComment : valueCommentBefore;
    if (carriedComment !== undefined && keyNode && keyNode.comment === undefined) {
      keyNode.comment = carriedComment;
    }
  }

  if (pair) {
    pair.value = sequence;
  } else {
    document.setIn(segments, sequence);
  }
}

function backupConfigValues(backend, document, keys) {
  if (keys.length === 0) return;
  const backupFile = path.join(backend.installDir, "previous.json");
  if (fs.existsSync(backupFile)) {
    log(backend.name, `配置备份已存在，保留首次备份：${backupFile}`);
    return;
  }

  const values = {};
  for (const key of keys) {
    const segments = key.split(".");
    values[key] = document.hasIn(segments)
      ? { exists: true, value: document.getIn(segments) }
      : { exists: false };
  }

  fs.mkdirSync(backend.installDir, { recursive: true });
  fs.writeFileSync(
    backupFile,
    `${JSON.stringify({ config_file: CONFIG_PATH, values }, null, 2)}\n`,
    "utf8",
  );
  log(backend.name, `已备份原配置值：${backupFile}`);
}

function configValueSummary(document, key) {
  if (!document) return { present: false, value: undefined };
  const segments = key.split(".");
  if (!document.hasIn(segments)) return { present: false, value: undefined };
  return { present: true, value: document.getIn(segments) };
}

// ---------------------------------------------------------------------------
// 版本记录与安装状态
// ---------------------------------------------------------------------------

function versionFile(backend) {
  return path.join(backend.installDir, "version.json");
}

function writeVersion(backend, version) {
  const record = {
    name: backend.name,
    version,
    installed_at: new Date().toISOString(),
    source: backend.source,
  };
  fs.mkdirSync(backend.installDir, { recursive: true });
  fs.writeFileSync(versionFile(backend), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  log(backend.name, `版本：${version}`);
}

function readVersion(backend) {
  const file = versionFile(backend);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 各后端定义
// ---------------------------------------------------------------------------

/** bili（kukemc/bili-cli，PyPI 包 bili-agent） */
const biliBackend = {
  name: "bili",
  title: "bili（kukemc/bili-cli）",
  source: "https://pypi.org/project/bili-agent/",
  installDir: path.join(BACKENDS_DIR, "bili"),
  createConfig: true,
  statusKeys: ["bilibili.cli_kukemc.command"],

  configKeys() {
    return ["bilibili.cli_kukemc.command"];
  },

  commandPath() {
    return venvBinPath(path.join(this.installDir, "venv"), "bili");
  },

  async install({ action }) {
    const python = findPython(this.name);
    const venvDir = path.join(this.installDir, "venv");
    const pythonPath = venvPythonPath(venvDir);

    if (!fs.existsSync(pythonPath)) {
      log(this.name, `创建 Python 虚拟环境：${venvDir}`);
      run(this.name, python, ["-m", "venv", venvDir]);
    } else {
      log(this.name, `复用已有虚拟环境：${venvDir}`);
    }

    log(this.name, `${action} bili-agent（pip install --upgrade）...`);
    run(this.name, pythonPath, ["-m", "pip", "install", "--upgrade", "bili-agent"]);

    const command = this.commandPath();
    if (!fs.existsSync(command)) {
      throw new Error(`安装完成但未找到 bili 可执行文件：${command}`);
    }

    return {
      command,
      version: pipShowVersion(this.name, pythonPath, "bili-agent"),
    };
  },

  applyConfig(document, result) {
    setConfigValue(document, ["bilibili", "cli_kukemc", "command"], result.command);
    return ["bilibili.cli_kukemc.command"];
  },

  tips(result) {
    log(this.name, "提示：本脚本不会自动登录或安装技能。如需使用，请手动执行：");
    console.log(`  "${result.command}" auth login`);
    console.log(`  "${result.command}" skills install`);
  },
};

/** ytdlp（yt-dlp/yt-dlp 最新 Release 独立二进制） */
function ytdlpTarget() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") {
    return { asset: "yt-dlp_linux", binary: "yt-dlp" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { asset: "yt-dlp_linux_aarch64", binary: "yt-dlp" };
  }
  if (platform === "darwin") {
    return { asset: "yt-dlp_macos", binary: "yt-dlp" };
  }
  if (platform === "win32") {
    return { asset: "yt-dlp.exe", binary: "yt-dlp.exe" };
  }
  throw new Error(`暂不支持当前平台：${platform}/${arch}`);
}

const ytdlpBackend = {
  name: "ytdlp",
  title: "yt-dlp（独立二进制）",
  source: "https://github.com/yt-dlp/yt-dlp",
  installDir: path.join(BACKENDS_DIR, "ytdlp"),
  createConfig: true,
  statusKeys: ["bilibili.cli_ytdlp.command"],

  configKeys() {
    return ["bilibili.cli_ytdlp.command"];
  },

  commandPath() {
    return path.join(this.installDir, IS_WIN ? "yt-dlp.exe" : "yt-dlp");
  },

  async install({ action }) {
    const target = ytdlpTarget();
    const release = await githubLatestRelease(this.name, "yt-dlp/yt-dlp");
    const assets = Array.isArray(release.assets) ? release.assets : [];

    const asset = assets.find((item) => item.name === target.asset);
    if (!asset) {
      throw new Error(`Release ${release.tag_name} 中未找到资产 ${target.asset}`);
    }
    const sumsAsset = assets.find((item) => item.name === "SHA2-256SUMS");
    if (!sumsAsset) {
      throw new Error(`Release ${release.tag_name} 中未找到 SHA2-256SUMS，无法校验下载内容`);
    }

    const temporary = path.join(this.installDir, `.${target.asset}.tmp-${process.pid}`);
    try {
      log(this.name, `${action}：下载 ${asset.name} ...`);
      await downloadFile(this.name, releaseAssetUrl(asset), temporary, asset.name);
      const sumsText = await fetchText(this.name, releaseAssetUrl(sumsAsset), sumsAsset.name);
      await verifySha256(this.name, temporary, sumsText, asset.name);

      const destination = path.join(this.installDir, target.binary);
      if (!IS_WIN) fs.chmodSync(temporary, 0o755);
      fs.rmSync(destination, { force: true });
      fs.renameSync(temporary, destination);
      if (!IS_WIN) fs.chmodSync(destination, 0o755);

      const version = capture(destination, ["--version"]).trim();
      if (!version) {
        throw new Error("yt-dlp --version 未返回版本号");
      }
      return { command: destination, version };
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  },

  applyConfig(document, result) {
    setConfigValue(document, ["bilibili", "cli_ytdlp", "command"], result.command);
    return ["bilibili.cli_ytdlp.command"];
  },

  tips() {
    log(this.name, "提示：如需高清或登录态，请在 bilibili.cli_ytdlp.cookies_file 配置 Netscape 格式 Cookie 文件。");
  },
};

/** opencli（@jackwener/opencli，微博后端） */
function syncWeiboOverride(name) {
  const source = path.join(ROOT, "scripts", "opencli-overrides", "weibo");
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    log(name, "当前分支不含微博插件（未找到 scripts/opencli-overrides/weibo/），已跳过。");
    return false;
  }

  const destination = path.join(os.homedir(), ".opencli", "clis", "weibo");
  copyDirectoryContents(source, destination);
  log(name, `已复制微博插件到：${destination}`);
  return true;
}

const opencliBackend = {
  name: "opencli",
  title: "opencli（@jackwener/opencli，微博后端）",
  source: "https://www.npmjs.com/package/@jackwener/opencli",
  installDir: path.join(BACKENDS_DIR, "opencli"),
  createConfig: false,
  statusKeys: ["weibo.cli.command"],

  configKeys(document) {
    if (!document || !document.has("weibo")) return [];
    return ["weibo.cli.command"];
  },

  commandPath() {
    return path.join(
      this.installDir,
      "node_modules",
      ".bin",
      IS_WIN ? "opencli.cmd" : "opencli",
    );
  },

  async install({ action }) {
    const current = process.versions.node;
    if (!nodeVersionAtLeast(current, "20.18.1")) {
      throw new Error(`需要 Node >= 20.18.1，当前为 ${current}。请升级 Node 后重试。`);
    }

    const npm = resolveNpm();
    const prefixArg = npm.shell ? `"${this.installDir}"` : this.installDir;
    log(this.name, `${action} @jackwener/opencli（npm install --prefix）...`);
    run(
      this.name,
      npm.command,
      [...npm.argsPrefix, "install", "--prefix", prefixArg, "--no-audit", "--no-fund", "@jackwener/opencli@latest"],
      { shell: npm.shell, cwd: this.installDir },
    );

    const packageJson = path.join(
      this.installDir,
      "node_modules",
      "@jackwener",
      "opencli",
      "package.json",
    );
    if (!fs.existsSync(packageJson)) {
      throw new Error(`npm 安装后未找到包文件：${packageJson}`);
    }
    const version = JSON.parse(fs.readFileSync(packageJson, "utf8")).version;
    if (!version) {
      throw new Error(`无法从 ${packageJson} 读取版本号`);
    }

    const command = this.commandPath();
    if (!fs.existsSync(command)) {
      throw new Error(`npm 安装后未找到命令：${command}`);
    }

    syncWeiboOverride(this.name);
    return { command, version };
  },

  applyConfig(document, result) {
    if (!document) {
      log(this.name, "未找到 gateway.yaml，仅安装，未写入配置。");
      return [];
    }
    if (!document.has("weibo")) {
      log(this.name, "当前配置不含微博段（weibo），仅安装，未写入配置。");
      return [];
    }
    setConfigValue(document, ["weibo", "cli", "command"], result.command);
    return ["weibo.cli.command"];
  },

  statusExtra(document) {
    if (document && document.has("weibo")) return;
    log(this.name, "备注：当前配置不含微博段（weibo），不会写入 weibo.cli.command。");
  },

  tips() {
    log(this.name, "提示：本脚本不会自动登录或启动浏览器，请按 opencli 文档自行完成微博登录。");
  },
};

/** article（djasdh/bilibili-article-server） */
function resolveArticlePort(document) {
  if (document) {
    const baseUrl = document.getIn(["bilibili", "http", "base_url"]);
    if (typeof baseUrl === "string" && baseUrl.trim()) {
      try {
        const parsed = new URL(baseUrl.trim());
        if (parsed.port) {
          const port = Number.parseInt(parsed.port, 10);
          if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
        }
      } catch {
        // 解析失败时回落到默认端口
      }
    }
  }
  return DEFAULT_ARTICLE_PORT;
}

const articleBackend = {
  name: "article",
  title: "bilibili-article-server（B 站专栏 HTTP 后端）",
  source: "https://github.com/djasdh/bilibili-article-server",
  installDir: path.join(BACKENDS_DIR, "article-server"),
  createConfig: true,
  statusKeys: ["bilibili.http.command", "bilibili.http.base_url"],

  configKeys() {
    return ["bilibili.http.command", "bilibili.http.base_url"];
  },

  commandPath() {
    return path.join(this.installDir, "server.py");
  },

  async install({ action }) {
    const python = findPython(this.name);
    const release = await githubLatestRelease(this.name, "djasdh/bilibili-article-server");
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const tag = String(release.tag_name || "");
    const expectedName = `bilibili-article-server-${tag.replace(/^v/, "")}.tar.gz`;

    const asset =
      assets.find((item) => item.name === expectedName) ||
      assets.find((item) => /^bilibili-article-server-.*\.tar\.gz$/.test(item.name));
    if (!asset) {
      throw new Error(`Release ${tag} 中未找到 bilibili-article-server-*.tar.gz 资产`);
    }
    const sumsAsset = assets.find((item) => item.name === "SHA256SUMS");
    if (!sumsAsset) {
      throw new Error(`Release ${tag} 中未找到 SHA256SUMS，无法校验下载内容`);
    }

    const nameMatch = asset.name.match(/^bilibili-article-server-(.+)\.tar\.gz$/);
    const version = tag.replace(/^v/, "") || (nameMatch ? nameMatch[1] : "unknown");

    const temporaryArchive = path.join(BACKENDS_DIR, `.article-${process.pid}.tar.gz`);
    const temporaryExtract = path.join(BACKENDS_DIR, `.article-extract-${process.pid}`);
    const holdingDir = path.join(BACKENDS_DIR, `.article-hold-${process.pid}`);
    const venvDir = path.join(this.installDir, "venv");
    const previousFile = path.join(this.installDir, "previous.json");
    const existingVersionFile = path.join(this.installDir, "version.json");

    fs.mkdirSync(BACKENDS_DIR, { recursive: true });
    let venvHeld = false;

    try {
      log(this.name, `${action}：下载 ${asset.name} ...`);
      await downloadFile(this.name, releaseAssetUrl(asset), temporaryArchive, asset.name);
      const sumsText = await fetchText(this.name, releaseAssetUrl(sumsAsset), sumsAsset.name);
      await verifySha256(this.name, temporaryArchive, sumsText, asset.name);

      fs.rmSync(temporaryExtract, { recursive: true, force: true });
      fs.mkdirSync(temporaryExtract, { recursive: true });
      extractTarGz(this.name, temporaryArchive, temporaryExtract);
      const sourceRoot = findFileRoot(temporaryExtract, "server.py");

      // 用临时目录替换安装目录，同时保留已有 venv 和首次配置备份。
      fs.rmSync(holdingDir, { recursive: true, force: true });
      fs.mkdirSync(holdingDir, { recursive: true });
      let previousData = null;
      let versionData = null;
      if (fs.existsSync(venvDir)) {
        fs.renameSync(venvDir, path.join(holdingDir, "venv"));
        venvHeld = true;
      }
      if (fs.existsSync(previousFile)) {
        previousData = fs.readFileSync(previousFile);
      }
      if (fs.existsSync(existingVersionFile)) {
        versionData = fs.readFileSync(existingVersionFile);
      }

      fs.rmSync(this.installDir, { recursive: true, force: true });
      fs.mkdirSync(this.installDir, { recursive: true });
      copyDirectoryContents(sourceRoot, this.installDir);
      if (previousData) {
        fs.writeFileSync(previousFile, previousData);
      }
      if (versionData) {
        fs.writeFileSync(existingVersionFile, versionData);
      }
      if (venvHeld) {
        fs.renameSync(path.join(holdingDir, "venv"), venvDir);
        venvHeld = false;
      }
    } catch (error) {
      if (venvHeld) {
        try {
          fs.renameSync(path.join(holdingDir, "venv"), venvDir);
          venvHeld = false;
        } catch {
          log(this.name, `警告：旧虚拟环境保留在 ${holdingDir}，请手动移回 ${venvDir}`);
        }
      }
      throw error;
    } finally {
      fs.rmSync(temporaryArchive, { force: true });
      fs.rmSync(temporaryExtract, { recursive: true, force: true });
      if (!venvHeld) {
        fs.rmSync(holdingDir, { recursive: true, force: true });
      }
    }

    const pythonPath = venvPythonPath(venvDir);
    if (!fs.existsSync(pythonPath)) {
      log(this.name, `创建 Python 虚拟环境：${venvDir}`);
      run(this.name, python, ["-m", "venv", venvDir]);
    }

    const requirements = path.join(this.installDir, "requirements.txt");
    if (!fs.existsSync(requirements)) {
      throw new Error(`安装包内未找到 requirements.txt：${requirements}`);
    }
    log(this.name, `${action} Python 依赖（pip install -r requirements.txt）...`);
    run(this.name, pythonPath, ["-m", "pip", "install", "--upgrade", "-r", requirements]);

    const serverPath = this.commandPath();
    if (!fs.existsSync(serverPath)) {
      throw new Error(`安装后未找到 server.py：${serverPath}`);
    }

    return { version, pythonPath, serverPath };
  },

  applyConfig(document, result) {
    const port = resolveArticlePort(document);
    setConfigValue(document, ["bilibili", "http", "base_url"], `http://127.0.0.1:${port}`);
    setConfigValue(
      document,
      ["bilibili", "http", "command"],
      [result.pythonPath, result.serverPath, "--host", "127.0.0.1", "--port", String(port)],
    );
    log(this.name, `已按端口 ${port} 写入 bilibili.http.command / base_url`);
    return ["bilibili.http.command", "bilibili.http.base_url"];
  },

  statusExtra() {
    const pythonPath = venvPythonPath(path.join(this.installDir, "venv"));
    const serverPath = this.commandPath();
    log(this.name, `venv Python：${pythonPath}（${fs.existsSync(pythonPath) ? "存在" : "不存在"}）`);
    log(this.name, `server.py：${serverPath}（${fs.existsSync(serverPath) ? "存在" : "不存在"}）`);
  },

  tips() {
    log(this.name, "提示：不写入任何 Cookie；登录态请通过网关进程环境变量 BILI_COOKIE 或 BILI_COOKIE_FILE 提供。");
  },
};

const BACKENDS = {
  bili: biliBackend,
  ytdlp: ytdlpBackend,
  opencli: opencliBackend,
  article: articleBackend,
};

// ---------------------------------------------------------------------------
// 子命令实现
// ---------------------------------------------------------------------------

async function installBackend(backend, action) {
  const existedBefore = fs.existsSync(backend.installDir);
  fs.mkdirSync(backend.installDir, { recursive: true });

  try {
    const document = loadConfigDocument({ create: backend.createConfig !== false });
    const keys = backend.configKeys(document);
    if (document && keys.length > 0) {
      backupConfigValues(backend, document, keys);
    }

    const result = await backend.install({ action });
    if (!result || !result.version) {
      throw new Error("安装流程未返回版本号");
    }

    const written = backend.applyConfig ? backend.applyConfig(document, result) || [] : [];
    if (document && written.length > 0) {
      saveConfigDocument(document);
      log(backend.name, `已写入配置 ${CONFIG_PATH}：${written.join(", ")}`);
    }

    writeVersion(backend, result.version);
    if (backend.tips) backend.tips(result);
    log(backend.name, `${action}完成。`);
  } catch (error) {
    // 首次安装失败时清理半成品；更新失败则保留原安装，便于排查或重试。
    if (!existedBefore) {
      fs.rmSync(backend.installDir, { recursive: true, force: true });
    }
    throw error;
  }
}

function statusBackend(backend) {
  const record = readVersion(backend);
  const document = loadConfigDocument({ create: false });

  console.log("");
  log(backend.name, backend.title);
  log(backend.name, `安装状态：${record ? "已安装" : "未安装"}`);
  if (record) {
    log(backend.name, `版本：${record.version || "未知"}`);
    log(backend.name, `安装时间：${record.installed_at || "未知"}`);
    log(backend.name, `来源：${record.source || backend.source}`);
  }
  log(backend.name, `安装路径：${backend.installDir}`);

  if (backend.commandPath) {
    const commandPath = backend.commandPath();
    log(backend.name, `可执行文件：${commandPath}（${fs.existsSync(commandPath) ? "存在" : "不存在"}）`);
  }

  for (const key of backend.statusKeys) {
    const summary = configValueSummary(document, key);
    log(
      backend.name,
      `配置 ${key}：${summary.present ? JSON.stringify(summary.value) : "（未设置）"}`,
    );
  }
  log(backend.name, `配置文件：${CONFIG_PATH}${document ? "" : "（不存在）"}`);

  if (backend.statusExtra) backend.statusExtra(document);
  console.log("");
}

function uninstallBackend(backend) {
  const backupFile = path.join(backend.installDir, "previous.json");
  let backup = null;
  if (fs.existsSync(backupFile)) {
    try {
      backup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
    } catch (error) {
      log(backend.name, `警告：previous.json 解析失败（${error.message}），将跳过配置还原`);
    }
  }

  if (backup && backup.values) {
    const document = loadConfigDocument({ create: false });
    if (document) {
      const restored = [];
      for (const [key, info] of Object.entries(backup.values)) {
        const segments = key.split(".");
        if (info && info.exists) {
          setConfigValue(document, segments, info.value);
        } else {
          document.deleteIn(segments);
        }
        restored.push(key);
      }
      saveConfigDocument(document);
      log(backend.name, `已还原配置：${restored.join(", ")}`);
    } else {
      log(backend.name, `配置文件不存在，跳过配置还原：${CONFIG_PATH}`);
    }
  } else {
    log(backend.name, "未找到配置备份，跳过配置还原。");
  }

  if (fs.existsSync(backend.installDir)) {
    fs.rmSync(backend.installDir, { recursive: true, force: true });
    log(backend.name, `已删除安装目录：${backend.installDir}`);
  } else {
    log(backend.name, `安装目录不存在（可能已卸载）：${backend.installDir}`);
  }

  log(backend.name, "卸载完成。");
}

function printUsage(exitCode) {
  console.log(`用法：node scripts/backends/cli.mjs <后端> [install|update|status|uninstall]

后端：
  bili      kukemc/bili-cli（PyPI 包 bili-agent）
  ytdlp     yt-dlp 独立二进制
  opencli   @jackwener/opencli（微博后端）
  article   bilibili-article-server（B 站专栏 HTTP 后端）

子命令：
  install   安装（默认）
  update    更新到最新版本（等同 install）
  status    查看安装状态与当前配置
  uninstall 卸载并还原首次安装前的配置

安装目录：data/backends/<后端>/（article 为 data/backends/article-server/）
配置文件：$GATEWAY_CONFIG_FILE，缺省为仓库根 gateway.yaml`);
  process.exit(exitCode);
}

async function main() {
  const backendName = process.argv[2];
  const subcommand = process.argv[3] || "install";

  if (!backendName) {
    printUsage(1);
  }
  if (backendName === "-h" || backendName === "--help") {
    printUsage(0);
  }

  const backend = BACKENDS[backendName];
  if (!backend) {
    console.error(`未知后端：${backendName}`);
    printUsage(1);
  }

  if (subcommand === "-h" || subcommand === "--help") {
    printUsage(0);
  }

  switch (subcommand) {
    case "install":
      await installBackend(backend, "安装");
      break;
    case "update":
      await installBackend(backend, "更新");
      break;
    case "status":
      statusBackend(backend);
      break;
    case "uninstall":
      uninstallBackend(backend);
      break;
    default:
      console.error(`未知子命令：${subcommand}`);
      printUsage(1);
  }
}

main().catch((error) => {
  console.error(`错误：${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
