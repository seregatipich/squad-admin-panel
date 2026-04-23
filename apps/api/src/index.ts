import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main() {
  const config = loadConfig();
  const app = await buildServer(config);

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'shutdown requested');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
