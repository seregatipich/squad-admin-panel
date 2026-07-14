import { BridgeClient } from '@squad/bridge-client';
import { createDatabaseClient, serverSettings, servers } from '@squad/db';
import { createDiag } from '@squad/diag';
import { redisSinkStream, startHeartbeat } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import pino, { multistream } from 'pino';
import { handleAltBanConnect } from './alt-ban/store.js';
import { BannedNameRuleCache } from './banname/rules-cache.js';
import { handleBannedNameConnect } from './banname/store.js';
import { ChatFlagDetector } from './chat/flag-rules.js';
import { handleChat } from './chat/store.js';
import { handleCombat, handleVehicle } from './combat/store.js';
import { dropCutoverServers } from './cutover.js';
import { persistEventEnvelope } from './event-store.js';
import { ExternalBanCache } from './external-ban/cache.js';
import { handleExternalBanConnect } from './external-ban/store.js';
import { TailManager } from './manager.js';
import { DEFAULT_SEED_ONLINE_THRESHOLD, handleMatchCommand } from './match/store.js';
import { handleMatchClose } from './match-roster/store.js';
import { LogIngestor } from './parser/ingest.js';
import { publish } from './publish.js';
import { handleReport } from './report/store.js';
import { scheduleLogRetentionSweep } from './retention.js';
import { tailContainerLogs } from './tail.js';
import { handleVote } from './vote/store.js';

const requiredEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`fatal: ${name} is required`);
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
  const log = pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-log-ingest' } },
    multistream([
      { stream: process.stdout },
      { stream: redisSinkStream({ redis, defaultSource: 'log-ingest' }) },
    ]),
  );
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));
  const bridge = new BridgeClient({
    socketPath: process.env.BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
    onLog: (m, meta) => log.info({ ...meta }, m),
  });

  const diag = createDiag({ redis, log });
  const stopLogRetentionSweep = scheduleLogRetentionSweep({ bridge, diag, log });

  const seedThreshold =
    Number(process.env.MATCH_SEED_ONLINE_THRESHOLD) || DEFAULT_SEED_ONLINE_THRESHOLD;

  const chatFlagDetector = new ChatFlagDetector(db);
  const bannedNameCache = new BannedNameRuleCache(db);
  const externalBanCache = new ExternalBanCache(db, redis);

  const manager = new TailManager((serverId, beaconPort) => {
    log.info({ serverId, beaconPort }, 'attaching log tail');
    let matchChain: Promise<void> = Promise.resolve();
    let voteChain: Promise<void> = Promise.resolve();
    let combatChain: Promise<void> = Promise.resolve();
    const ingestor = new LogIngestor({
      serverId,
      beaconPort,
      onParseError: (report) => {
        diag
          .emit({
            component: 'worker-log-ingest',
            kind: 'parser_error',
            severity: 'warn',
            serverId,
            message: report.errorMessage,
            payload: {
              lineSample: report.lineSample,
              regex: report.regex,
              errorMessage: report.errorMessage,
            },
          })
          .catch(() => undefined);
      },
      onSquadFatal: (report) => {
        diag
          .emit({
            component: 'worker-log-ingest',
            kind: 'squad.log.fatal',
            severity: 'fatal',
            serverId,
            message: report.message.slice(0, 200),
            payload: {
              ts: report.ts,
              file: report.file,
              line: report.line,
              raw: report.raw.slice(0, 500),
            },
          })
          .catch(() => undefined);
      },
      onReport: (report) => {
        handleReport(db, redis, { serverId, report }).catch((err) =>
          log.error({ err: (err as Error).message }, 'report handling failed'),
        );
      },
      onMatch: (command) => {
        matchChain = matchChain
          .then(() => handleMatchCommand(db, redis, command, { seedThreshold }))
          .then(async () => {
            await handleMatchClose(db, command);
          })
          .catch((err) =>
            log.error({ err: (err as Error).message, kind: command.kind }, 'match assembly failed'),
          );
      },
      onChat: (chat) => {
        handleChat(db, redis, { serverId, chat }, chatFlagDetector).catch((err) =>
          log.error({ err: (err as Error).message }, 'chat handling failed'),
        );
      },
      onVote: (command) => {
        voteChain = voteChain
          .then(() => handleVote(db, redis, command))
          .then(() => undefined)
          .catch((err) => log.error({ err: (err as Error).message }, 'vote handling failed'));
      },
      onCombat: (command) => {
        combatChain = combatChain
          .then(() => handleCombat(db, redis, command))
          .then(() => undefined)
          .catch((err) =>
            log.error(
              { err: (err as Error).message, kind: command.kind },
              'combat handling failed',
            ),
          );
      },
      onVehicle: (command) => {
        combatChain = combatChain
          .then(() => handleVehicle(db, redis, command))
          .then(() => undefined)
          .catch((err) =>
            log.error(
              { err: (err as Error).message, kind: command.kind },
              'vehicle handling failed',
            ),
          );
      },
    });
    const abort = tailContainerLogs({
      bridge,
      log,
      name: `squad-${serverId}`,
      onLine(line) {
        const events = ingestor.ingest(line);
        for (const e of events) {
          persistEventEnvelope(db, e).catch((err) =>
            log.error({ err: (err as Error).message, type: e.type }, 'event persist failed'),
          );
          publish(redis, e).catch((err) =>
            log.error({ err: (err as Error).message, type: e.type }, 'publish failed'),
          );
          if (e.type === 'player.connected') {
            handleAltBanConnect(db, redis, e).catch((err) =>
              log.error({ err: (err as Error).message }, 'alt-ban handling failed'),
            );
            handleBannedNameConnect(db, redis, { serverId, event: e }, bannedNameCache).catch(
              (err) => log.error({ err: (err as Error).message }, 'banname handling failed'),
            );
            handleExternalBanConnect(db, redis, externalBanCache, { serverId, event: e }).catch(
              (err) => log.error({ err: (err as Error).message }, 'external-ban handling failed'),
            );
          }
        }
      },
      onStarted: () => {
        diag
          .emit({
            component: 'worker-log-ingest',
            kind: 'tail.started',
            severity: 'info',
            serverId,
            message: `tail started for squad-${serverId}`,
            payload: { container: `squad-${serverId}` },
          })
          .catch(() => undefined);
      },
      onStopped: ({ reason, error }) => {
        diag
          .emit({
            component: 'worker-log-ingest',
            kind: 'tail.stopped',
            severity: 'info',
            serverId,
            message: `tail stopped for squad-${serverId} (${reason})`,
            payload: {
              container: `squad-${serverId}`,
              reason,
              ...(error ? { error } : {}),
            },
          })
          .catch(() => undefined);
      },
    });
    return { abort };
  }, diag);

  async function reconcile() {
    const rows = await db
      .select({
        id: servers.id,
        status: servers.status,
        beaconPort: serverSettings.beaconPort,
      })
      .from(servers)
      .innerJoin(serverSettings, eq(servers.id, serverSettings.serverId));
    const wanted = rows
      .filter((r) => r.status === 'running' || r.status === 'starting')
      .map((r) => ({ serverId: r.id, beaconPort: r.beaconPort }));
    const active = await dropCutoverServers(redis, wanted);
    manager.reconcile(active);
  }

  await reconcile();
  const interval = setInterval(() => {
    reconcile().catch((err) => log.error({ err: (err as Error).message }, 'reconcile failed'));
  }, 15_000);

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'log-ingest',
    statusFn: () => `tails=${manager.size()}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopHeartbeat();
    stopLogRetentionSweep();
    clearInterval(interval);
    manager.stopAll();
    await redis.quit().catch(() => undefined);
    await bridge.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  log.info('worker-log-ingest ready');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
