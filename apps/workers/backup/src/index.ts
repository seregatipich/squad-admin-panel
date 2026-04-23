import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-backup' } });

/**
 * Phase 0 stub. Functionality deferred to the phase indicated in TZ §2.2.
 */
async function main() {
  log.info('worker-backup idle — deferred to later phase');
  const heartbeat = setInterval(() => log.debug('heartbeat'), 60_000);
  const shutdown = (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    clearInterval(heartbeat);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
