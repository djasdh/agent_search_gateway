import { Logger } from "./logger.js";
import { closeGatewayRuntime, createServer, startHttpServer } from "./server.js";
import { loadSettings } from "./settings/index.js";

function loadSettingsOrExit() {
  try {
    return loadSettings();
  } catch (err) {
    console.error(`[gateway] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { settings, secrets, warnings } = loadSettingsOrExit();

  const logger = new Logger(settings.logging.level, settings.logging.file);
  for (const warning of warnings) logger.warn(warning);
  logger.info(
    `config loaded: host=${settings.gateway.host} port=${settings.gateway.port} ` +
      `searxng=${settings.searxng.url} flaresolverr=${settings.flaresolverr.url} ` +
      `token=${secrets.gateway.token ? "set" : "none"}`,
  );

  try {
    const http = await startHttpServer({ settings, secrets, logger }, createServer);

    const shutdown = async (signal: string) => {
      logger.info(`received ${signal}, shutting down...`);
      try {
        await http.close();
      } catch (err) {
        logger.error(`error closing http server: ${String(err)}`);
      }
      try {
        await closeGatewayRuntime();
      } catch (err) {
        logger.error(`error closing gateway runtime: ${String(err)}`);
      }
      logger.close();
      process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
    // 未捕获异常：记录后退出，交给 systemd/进程管理器拉起。
    // 带病存活可能处于半初始化状态继续服务，比崩溃更糟。
    process.on("uncaughtException", (err) => {
      logger.error(`uncaught exception, exiting: ${err.stack ?? String(err)}`);
      logger.close();
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      logger.error(`unhandled rejection: ${String(reason)}`);
    });

    logger.info(`gateway ready at ${http.url}`);
  } catch (err) {
    logger.error(`startup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    logger.close();
    process.exit(1);
  }
}

void main();
