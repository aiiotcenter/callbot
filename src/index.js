const { config } = require("./config");
const { buildServer } = require("./server");

async function start() {
  const app = buildServer();

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info({ host: config.HOST, port: config.PORT }, "Callbot service started");
  } catch (error) {
    app.log.fatal({ err: error }, "Failed to start server");
    process.exit(1);
  }

  const shutdown = async (signal) => {
    app.log.info({ signal }, "Shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "Shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start();
