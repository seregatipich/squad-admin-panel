import { BridgeClient } from '@squad/bridge-client';
import { createDatabaseClient, serverSettings, servers } from '@squad/db';
import { startHeartbeat } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import pino from 'pino';
import { LogIngestor } from './parser/ingest.js';
import { publish } from './publish.js';
import { tailContainerLogs } from './tail.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-log-ingest' },
});

const requiredEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return v;
};

async function main() {
  const db = createDatabaseClient(requiredEnv('DATABASE_URL'));
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));
  const bridge = new BridgeClient({
    socketPath: process.env.BRIDGE_SOCKET ?? '/run/panel-host-bridge.sock',
    onLog: (m, meta) => log.info({ ...meta }, m),
  });

  const aborters = new Map<string, () => void>();

  async function reconcile() {
    const rows = await db
      .select({
        id: servers.id,
        status: servers.status,
        beaconPort: serverSettings.beaconPort,
      })
      .from(servers)
      .innerJoin(serverSettings, eq(servers.id, serverSettings.serverId));
    const wanted = new Set<string>();
    for (const row of rows) {
      if (row.status === 'running' || row.status === 'starting') {
        wanted.add(row.id);
        if (!aborters.has(row.id)) {
          attachTail(row.id, row.beaconPort);
        }
      }
    }
    for (const id of aborters.keys()) {
      if (!wanted.has(id)) {
        aborters.get(id)?.();
        aborters.delete(id);
      }
    }
  }

  function attachTail(serverId: string, beaconPort: number) {
    log.info({ serverId, beaconPort }, 'attaching log tail');
    const ingestor = new LogIngestor({ serverId, beaconPort });
    const abort = tailContainerLogs({
      bridge,
      log,
      name: `squad-${serverId}`,
      onLine(line) {
        const events = ingestor.ingest(line);
        for (const e of events) {
          publish(redis, e).catch((err) =>
            log.error({ err: (err as Error).message, type: e.type }, 'publish failed'),
          );
        }
      },
    });
    aborters.set(serverId, abort);
  }

  await reconcile();
  const interval = setInterval(() => {
    reconcile().catch((err) => log.error({ err: (err as Error).message }, 'reconcile failed'));
  }, 15_000);

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'log-ingest',
    statusFn: () => `tails=${aborters.size}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopHeartbeat();
    clearInterval(interval);
    for (const abort of aborters.values()) abort();
    aborters.clear();
    await redis.quit().catch(() => undefined);
    await bridge.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  log.info('worker-log-ingest ready');
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
