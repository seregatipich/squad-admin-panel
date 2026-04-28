import { createDatabaseClient, serverCredentials, serverSettings, servers } from '@squad/db';
import { createDiag } from '@squad/diag';
import { redisSinkStream, resolveRconHost, startHeartbeat } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import pino, { multistream } from 'pino';
import { RconSupervisor, type Target } from './supervisor.js';

const requiredEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`fatal: ${name} is required`);
    process.exit(1);
  }
  return v;
};

/**
 * In production the RCON password is stored as an encrypted blob in
 * `server_credentials.rcon_password_encrypted`. This worker reads the
 * raw bytea and decrypts via APP_ENCRYPTION_KEY. For Phase 0 we only
 * stand up the plumbing; the crypto helper is shared with the API via
 * apps/api/src/lib/crypto.ts. We re-implement a tiny subset here to
 * avoid coupling the worker to the API package.
 */
import { createDecipheriv } from 'node:crypto';

interface Blob {
  v: 1;
  kv: number;
  iv: string;
  tag: string;
  ct: string;
}

function decrypt(key: Buffer, blob: Blob): string {
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf-8');
}

async function main() {
  const db = createDatabaseClient(requiredEnv('DATABASE_URL'));
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  const log = pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-rcon' } },
    multistream([
      { stream: process.stdout },
      { stream: redisSinkStream({ redis, defaultSource: 'rcon' }) },
    ]),
  );
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));
  const key = Buffer.from(requiredEnv('APP_ENCRYPTION_KEY'), 'base64');
  if (key.byteLength !== 32) {
    log.fatal('APP_ENCRYPTION_KEY must decode to 32 bytes');
    process.exit(1);
  }

  const diag = createDiag({ redis, log });
  const supervisor = new RconSupervisor({ db, redis, log, diag });

  async function reconcile() {
    const rows = await db
      .select({
        serverId: servers.id,
        status: servers.status,
        host: serverCredentials.rconHost,
        port: serverCredentials.rconPort,
        blob: serverCredentials.rconPasswordEncrypted,
      })
      .from(servers)
      .innerJoin(serverCredentials, eq(servers.id, serverCredentials.serverId))
      .innerJoin(serverSettings, eq(servers.id, serverSettings.serverId));
    const targets: Target[] = [];
    for (const row of rows) {
      if (row.status !== 'running' && row.status !== 'starting') continue;
      try {
        const blob = JSON.parse(
          Buffer.from(row.blob as unknown as Buffer).toString('utf-8'),
        ) as Blob;
        targets.push({
          serverId: row.serverId,
          host: resolveRconHost(row.host),
          port: row.port,
          password: decrypt(key, blob),
        });
      } catch (err) {
        log.error(
          { err: (err as Error).message, serverId: row.serverId },
          'rcon credentials decrypt failed',
        );
      }
    }
    await supervisor.reconcile(targets);
  }

  await reconcile();
  const interval = setInterval(() => {
    reconcile().catch((err) => log.error({ err: (err as Error).message }, 'reconcile failed'));
  }, 15_000);

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'rcon',
    statusFn: () => `targets=${supervisor.size()}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopHeartbeat();
    clearInterval(interval);
    await supervisor.stop();
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  log.info('worker-rcon ready');
}

main().catch((err) => {
  console.error('fatal', (err as Error).message);
  process.exit(1);
});
