import { createDecipheriv } from 'node:crypto';
import { ChatFlagDetector, PlayerIdCache } from '@squad/chat-ingest';
import { createDatabaseClient, serverCredentials, serverSettings, servers } from '@squad/db';
import { createDiag } from '@squad/diag';
import {
  parseRconRefreshHint,
  RCON_REFRESH_CHANNEL,
  redisSinkStream,
  resolveRconHost,
  startHeartbeat,
} from '@squad/shared-config';
import { type HostCidr, parsePrivateHostAllowlist } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import pino, { multistream } from 'pino';
import { z } from 'zod';
import { positiveIntEnv } from './env.js';
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
 * The RCON password is stored in `server_credentials.rcon_password_encrypted`
 * as a JSON envelope encrypted with AES-256-GCM under APP_ENCRYPTION_KEY. This
 * mirrors the subset of `apps/api/src/lib/crypto.ts` the worker needs, without
 * coupling it to the API package.
 */
const encryptedBlobSchema = z.object({
  v: z.literal(1),
  kv: z.number(),
  iv: z.string().transform((value) => Buffer.from(value, 'base64')),
  tag: z.string().transform((value) => Buffer.from(value, 'base64')),
  ct: z.string().transform((value) => Buffer.from(value, 'base64')),
});

function decrypt(key: Buffer, rawBlob: Buffer): string {
  const blob = encryptedBlobSchema.parse(JSON.parse(rawBlob.toString('utf-8')));
  if (blob.iv.byteLength !== 12) throw new Error('invalid credentials iv length');
  if (blob.tag.byteLength !== 16) throw new Error('invalid credentials tag length');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.iv, { authTagLength: 16 });
  decipher.setAuthTag(blob.tag);
  return Buffer.concat([decipher.update(blob.ct), decipher.final()]).toString('utf-8');
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
  let privateHostAllowlist: HostCidr[] | null;
  try {
    privateHostAllowlist = parsePrivateHostAllowlist(process.env.EXTERNAL_HOST_PRIVATE_ALLOWLIST);
  } catch (err) {
    log.fatal({ err: (err as Error).message }, 'EXTERNAL_HOST_PRIVATE_ALLOWLIST is invalid');
    process.exit(1);
  }

  const diag = createDiag({ redis, log });
  const supervisor = new RconSupervisor({
    db,
    redis,
    log,
    diag,
    chatFlagDetector: new ChatFlagDetector(db),
    playerIds: new PlayerIdCache(),
    rosterIntervalMs: positiveIntEnv(process.env.RCON_ROSTER_INTERVAL_MS),
    infoIntervalMs: positiveIntEnv(process.env.RCON_INFO_INTERVAL_MS),
  });

  // Refresh hints (log-ingest saw a join, a leave, a new match) get their own
  // connection: a subscribed ioredis client cannot issue regular commands.
  const hints = redis.duplicate();
  hints.on('error', (err: Error) => log.warn({ err: err.message }, 'hint subscriber error'));
  hints.on('message', (channel: string, raw: string) => {
    if (channel !== RCON_REFRESH_CHANNEL) return;
    const hint = parseRconRefreshHint(raw);
    if (!hint) return;
    supervisor.hint(hint.server_id, hint.scopes, hint.reason);
  });
  await hints.subscribe(RCON_REFRESH_CHANNEL).catch((err: Error) => {
    // Hints only speed things up; the poll timers still keep the panel fresh.
    log.warn({ err: err.message }, 'rcon refresh hint subscribe failed');
  });

  async function reconcile() {
    const rows = await db
      .select({
        serverId: servers.id,
        status: servers.status,
        runtime: servers.runtime,
        host: serverCredentials.rconHost,
        port: serverCredentials.rconPort,
        queryPort: serverSettings.queryPort,
        tickrate: serverSettings.tickrate,
        seedLiveAt: serverSettings.seedLiveAt,
        seedHysteresis: serverSettings.seedHysteresis,
        blob: serverCredentials.rconPasswordEncrypted,
      })
      .from(servers)
      .innerJoin(serverCredentials, eq(servers.id, serverCredentials.serverId))
      .innerJoin(serverSettings, eq(servers.id, serverSettings.serverId));
    const targets: Target[] = [];
    for (const row of rows) {
      if (row.status !== 'running' && row.status !== 'starting') continue;
      try {
        targets.push({
          serverId: row.serverId,
          host: resolveRconHost(row.host),
          port: row.port,
          queryPort: row.queryPort,
          tickrate: row.tickrate ?? undefined,
          seedLiveAt: row.seedLiveAt ?? undefined,
          seedHysteresis: row.seedHysteresis ?? undefined,
          password: decrypt(key, Buffer.from(row.blob)),
          refuseRestrictedAddresses: row.runtime === 'external',
          privateHostAllowlist,
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

  let interval: NodeJS.Timeout | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let shuttingDown = false;
  const shutdown = async (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'shutdown');
    const forceExit = setTimeout(() => {
      log.warn('graceful shutdown timed out; forcing exit');
      process.exit(0);
    }, 3000);
    forceExit.unref();
    stopHeartbeat?.();
    if (interval) clearInterval(interval);
    await supervisor.stop().catch(() => undefined);
    await hints.quit().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    clearTimeout(forceExit);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await reconcile();
  // Passes never overlap: supervisors are stopped and replaced during a pass, so
  // a second one must not start while the first is still waiting on that.
  let reconciling = false;
  interval = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    reconcile()
      .catch((err) => log.error({ err: (err as Error).message }, 'reconcile failed'))
      .finally(() => {
        reconciling = false;
      });
  }, 15_000);

  stopHeartbeat = startHeartbeat({
    redis,
    name: 'rcon',
    statusFn: () => `targets=${supervisor.size()}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  log.info('worker-rcon ready');
}

main().catch((err) => {
  console.error('fatal', (err as Error).message);
  process.exit(1);
});
