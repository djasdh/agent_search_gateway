/**
 * 抓取通道契约（第二步）。
 *
 * 平台对象（FetchPlugin）负责 URL 匹配与取件编排；通道对象（FetchChannel）
 * 描述具体后端：CLI 命令、HTTP 服务或会话型后端。当前通道主要是**静态元数据**，
 * 运行时执行仍由各插件内部的 router / CLI / HTTP 实现完成。
 *
 * `src/fetch/channels/` 是给外部插件依赖的稳定接口；运行时加载留到后续。
 */
import type { Logger } from "../../logger.js";
import type { FetchPluginSecrets, FetchPluginSettings } from "../../settings/index.js";

export type FetchChannelKind = "cli" | "http" | "session";

export interface ChannelProbe {
  ok: boolean;
  version?: string;
  authenticated?: boolean;
  message?: string;
}

export interface ChannelContext {
  settings: FetchPluginSettings;
  secrets: FetchPluginSecrets;
  getSecret(path: string): string | undefined;
  logger?: Logger;
}

export interface FetchChannel {
  /** 规范 ID：`${platform}:${channel}` */
  id: string;
  platform: string;
  channel: string;
  displayName: string;
  kind: FetchChannelKind;
  capabilities: readonly string[];
  aliases?: readonly string[];
  probe?(ctx: ChannelContext): Promise<ChannelProbe>;
  dispose?(): Promise<void>;
}

export interface CliRunOptions {
  timeoutMs: number;
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CliResult {
  failed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
}

export interface CliChannel extends FetchChannel {
  kind: "cli";
  readonly command: string;
  run(args: readonly string[], opts: CliRunOptions): Promise<CliResult>;
}

export interface HttpChannel extends FetchChannel {
  kind: "http" | "session";
  request(input: string | URL, init?: RequestInit): Promise<Response>;
}
