import type { BrowserPoolSettings } from "../../src/browser/pool.js";
import type { BrowserToolSettings } from "../../src/browser/tools.js";
import type { FlareSolverrSettingsDeps } from "../../src/fetch/flaresolverr.js";
import type { DirectFetchDeps } from "../../src/fetch/direct.js";
import type { FetchServiceDeps } from "../../src/fetch/service.js";
import type { HealthSettings } from "../../src/health.js";
import type { SearchSettingsDeps } from "../../src/search/service.js";
import {
  defaultSecrets,
  defaultSettings,
  ssrfOf,
  type Secrets,
  type Settings,
} from "../../src/settings/index.js";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深度合并；数组整体替换，不按下标合并。 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch as T;
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: PlainObject = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = deepMerge((base as PlainObject)[key], value);
    }
    return out as T;
  }
  return patch as T;
}

/** 基于真实默认值构造 Settings（测试与运行时共用同一份默认值）。 */
export function makeSettings(overrides: DeepPartial<Settings> = {}): Settings {
  return deepMerge(defaultSettings(), overrides);
}

export function makeSecrets(overrides: DeepPartial<Secrets> = {}): Secrets {
  return deepMerge(defaultSecrets(), overrides);
}

export function browserPoolDeps(
  settings: Settings,
  secrets: Secrets = makeSecrets(),
): BrowserPoolSettings {
  return {
    browser: settings.browser,
    ssrf: ssrfOf(settings.fetch),
    proxy_password: secrets.browser.proxy_password,
  };
}

export function browserToolDeps(settings: Settings): BrowserToolSettings {
  return { browser: settings.browser, ssrf: ssrfOf(settings.fetch) };
}

export function directDeps(settings: Settings, secrets: Secrets = makeSecrets()): DirectFetchDeps {
  return {
    fetch: settings.fetch,
    plugins: {
      settings: { fetch: settings.fetch, bilibili: settings.bilibili, weibo: settings.weibo },
      secrets: { bilibili: { http: { token: secrets.bilibili.http.token } } },
    },
  };
}

export function fetchServiceDeps(
  settings: Settings,
  secrets: Secrets = makeSecrets(),
): FetchServiceDeps {
  return {
    fetch: settings.fetch,
    flaresolverr: settings.flaresolverr,
    browser: settings.browser,
    files_base_url: filesBaseUrl(settings),
    plugins: {
      settings: { fetch: settings.fetch, bilibili: settings.bilibili, weibo: settings.weibo },
      secrets: { bilibili: { http: { token: secrets.bilibili.http.token } } },
    },
  };
}

export function flareSolverrDeps(settings: Settings): FlareSolverrSettingsDeps {
  return { flaresolverr: settings.flaresolverr, ssrf: ssrfOf(settings.fetch) };
}

export function searchServiceDeps(
  settings: Settings,
  secrets: Secrets = makeSecrets(),
): SearchSettingsDeps {
  return {
    search: settings.search,
    rerank: settings.rerank,
    searxng: settings.searxng,
    saucenao_api_key: secrets.search.reverse_image.saucenao.api_key,
    weibo: settings.weibo,
  };
}

export function healthDeps(settings: Settings): HealthSettings {
  return {
    searxng: settings.searxng,
    flaresolverr: settings.flaresolverr,
    embedding: settings.embedding,
  };
}

export function filesBaseUrl(settings: Settings): string {
  const { host, port } = settings.gateway;
  const h = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  return `http://${h}:${port}`;
}
