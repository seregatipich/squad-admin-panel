import pino from 'pino';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-audit-archiver' },
});

/**
 * Phase 0 stub. The archiver runs every 24 hours and exports a verified
 * hash-chain snapshot of audit_log to restic (same sidecar already used
 * for pg_dump backups). Phase 0 acceptance requires the scaffolding
 * only; real export logic lands in Phase 1 per TZ §5.
 */
async function main() {
  log.info('worker-audit-archiver idle — Phase 1 functionality deferred');
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
