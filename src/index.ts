import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { createServer, startHttpServer } from "./server.js";

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[gateway] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();

  const logger = new Logger(config.logLevel, config.logFile);
  logger.info(`config loaded: host=${config.host} port=${config.port} searxng=${config.searxngUrl} flaresolverr=${config.flaresolverrUrl} token=${config.token ? "set" : "none"}`);

  try {
    const http = await startHttpServer({ config, logger }, createServer);

    const shutdown = async (signal: string) => {
      logger.info(`received ${signal}, shutting down...`);
      try {
        await http.close();
      } catch (err) {
        logger.error(`error closing http server: ${String(err)}`);
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
