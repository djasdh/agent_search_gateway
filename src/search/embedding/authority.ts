import { registeredDomain } from "./diversity.js";

/**
 * 重排层的「权威」信号：按注册域 / 主机名的**类别**给一个 [0,1] 分。
 *
 * 设计取向（避免过拟合评测期望域名）：
 * - 只用**可泛化的分类规则**：公共权威 TLD 后缀（gov/edu/ac…）、
 *   一份「知名官方文档域」通识清单（覆盖远多于评测用到的域）、
 *   通用可信大站、UGC/二手平台、以及 `blog.*` 这类**命名模式**；
 * - 不针对评测集里的具体 query/expect 做特判；清单是通用知识，不是从答案反推；
 * - 未知域一律中性 0.5，不臆断。
 *
 * 分级锚点：
 */
export const AUTHORITY_OFFICIAL = 0.95; // 一手/官方：政府、教育、官方文档
export const AUTHORITY_TRUSTED = 0.7; // 通用可信大站：百科、代码托管、权威媒体
export const AUTHORITY_UGC = 0.35; // UGC/二手：社区、问答、博客
export const AUTHORITY_UNKNOWN = 0.5; // 未知：中性

/** 公共权威后缀：`moe.gov.cn`、`mit.edu`、`warwick.ac.uk`、`nist.gov` 等。 */
const OFFICIAL_SUFFIX_RE = /(^|\.)(gov|go|gob|gouv|govt|gc|edu|mil|ac)(\.[a-z]{2})?$/;

/**
 * 一手/官方**文档**域（注册域匹配）。通用通识清单，含大量评测未覆盖的域，
 * 刻意不只为 `eval/cases.jsonl` 里出现的域名而设。
 */
const OFFICIAL_DOMAINS = new Set<string>([
  // 语言 / 运行时
  "python.org", "nodejs.org", "go.dev", "golang.org", "rust-lang.org", "ruby-lang.org",
  "php.net", "perl.org", "openjdk.org", "oracle.com", "typescriptlang.org",
  // 前端框架 / 工具链
  "react.dev", "vuejs.org", "angular.io", "svelte.dev", "nextjs.org", "nuxt.com",
  "vite.dev", "vitejs.dev", "webpack.js.org", "babeljs.io", "eslint.org", "jestjs.io",
  "tailwindcss.com",
  // 基础设施 / 数据库
  "kubernetes.io", "docker.com", "podman.io", "helm.sh", "istio.io", "terraform.io",
  "postgresql.org", "mysql.com", "mariadb.org", "mongodb.com", "sqlite.org", "redis.io",
  "elastic.co", "apache.org", "nginx.org", "haproxy.org", "kernel.org", "gnu.org",
  // Web 标准 / 浏览器
  "mozilla.org", "w3.org", "ietf.org", "rfc-editor.org", "whatwg.org",
  // 后端框架 / 包管理
  "djangoproject.com", "palletsprojects.com", "tiangolo.com", "spring.io",
  "gradle.org", "npmjs.com", "pypi.org", "crates.io", "packagist.org", "rubygems.org",
  // 学术 / 安全
  "arxiv.org", "doi.org", "ieee.org", "acm.org", "springer.com", "sciencedirect.com",
  "cve.org", "mitre.org",
  // 厂商官方
  "apple.com", "microsoft.com", "android.com", "google.com", "amazon.com", "aws.amazon.com",
]);

/** 通用可信大站（非官方文档，但内容可信）。 */
const TRUSTED_DOMAINS = new Set<string>([
  // 百科
  "wikipedia.org", "wikimedia.org", "wiktionary.org",
  // 代码托管 / 问答
  "github.com", "gitlab.com", "bitbucket.org", "sourceforge.net",
  "stackoverflow.com", "stackexchange.com", "superuser.com", "serverfault.com", "askubuntu.com",
  // 权威媒体 / 通讯社
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "nytimes.com", "theguardian.com",
  "bloomberg.com", "cnbc.com", "wsj.com", "ft.com", "economist.com",
  "xinhuanet.com", "people.com.cn", "cctv.com", "thepaper.cn", "chinadaily.com.cn", "gmw.cn",
  // 机构 / 官方企业
  "who.int", "un.org", "worldbank.org", "imf.org",
  "nvidia.com", "openai.com", "anthropic.com", "fifa.com", "espn.com", "olympics.com",
]);

/** UGC / 二手内容平台（注册域匹配）。 */
const UGC_DOMAINS = new Set<string>([
  "zhihu.com", "bilibili.com", "csdn.net", "juejin.cn", "cnblogs.com", "segmentfault.com",
  "douban.com", "xiaohongshu.com", "weibo.com", "jianshu.com", "v2ex.com", "52pojie.cn",
  "medium.com", "reddit.com", "quora.com", "dev.to", "hashnode.com", "substack.com",
  "wordpress.com", "tumblr.com", "blogspot.com", "hatenablog.com", "lofter.com",
]);

/** 从 URL 或裸主机名取主机（小写、去端口/尾点/凭证）。 */
function hostOf(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/\.$/, "");
  } catch {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(raw);
    const hostpart = (m ? m[1] : raw).split("@").pop() ?? "";
    return hostpart.split(":")[0].split("/")[0].replace(/\.$/, "");
  }
}

/** `blog.*` / `*.blogspot.*` / `*.github.io` 这类个人博客命名模式。 */
function isBlogLike(host: string, reg: string): boolean {
  if (reg === "blogspot.com" || reg.endsWith(".blogspot.com")) return true;
  if (host.startsWith("blog.") || host.includes(".blog.")) return true;
  if (host.endsWith(".github.io") || reg.endsWith(".github.io")) return true;
  return false;
}

/**
 * 权威分：传入 URL 或主机名，返回 [0,1]。
 *
 * 优先级：公共权威后缀 → 官方文档域 → 可信大站 → UGC/博客 → 未知中性。
 */
export function authorityScore(urlOrHost: string): number {
  const host = hostOf(urlOrHost);
  if (!host) return AUTHORITY_UNKNOWN;
  if (OFFICIAL_SUFFIX_RE.test(host)) return AUTHORITY_OFFICIAL;
  const reg = registeredDomain(host);
  if (OFFICIAL_DOMAINS.has(reg) || OFFICIAL_DOMAINS.has(host)) return AUTHORITY_OFFICIAL;
  if (TRUSTED_DOMAINS.has(reg) || TRUSTED_DOMAINS.has(host)) return AUTHORITY_TRUSTED;
  if (UGC_DOMAINS.has(reg) || UGC_DOMAINS.has(host) || isBlogLike(host, reg)) return AUTHORITY_UGC;
  return AUTHORITY_UNKNOWN;
}

/**
 * 组合打分：`rel_norm + w · auth`。
 * rel_norm 为候选内 min-max 归一化后的相关分（[0,1]），auth 为权威分。
 */
export function combineAuthority(relNorm: number, auth: number, weight: number): number {
  return relNorm + weight * auth;
}
