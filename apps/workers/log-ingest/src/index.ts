import { BridgeClient } from '@squad/bridge-client';
import { createDatabaseClient, serverLogSources, serverSettings, servers } from '@squad/db';
import { createDiag } from '@squad/diag';
import {
  createGracefulShutdownController,
  redisSinkStream,
  startHeartbeat,
} from '@squad/shared-config';
import { logSourceStatusKey } from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import Redis from 'ioredis';
import pino, { multistream } from 'pino';
import { handleAltBanConnect } from './alt-ban/store.js';
import { handleAutomationChat } from './automation/chat.js';
import { BannedNameRuleCache } from './banname/rules-cache.js';
import { handleBannedNameEvent } from './banname/store.js';
import { handleChatCommand } from './chat/commands.js';
import { ChatFlagDetector } from './chat/flag-rules.js';
import { handleChat } from './chat/store.js';
import { handleCombat, handleVehicle } from './combat/store.js';
import { decrypt, deserialize, loadEncryptionKey } from './crypto.js';
import { dropCutoverServers } from './cutover.js';
import { persistEventEnvelope } from './event-store.js';
import { ExternalBanCache } from './external-ban/cache.js';
import { handleExternalBanConnect } from './external-ban/store.js';
import { TailManager, type TailWanted } from './manager.js';
import { DEFAULT_SEED_ONLINE_THRESHOLD, handleMatchCommand } from './match/store.js';
import { handleMatchClose } from './match-roster/store.js';
import { LogIngestor } from './parser/ingest.js';
import { handlePlayerConnected } from './player-identity/store.js';
import { publish } from './publish.js';
import { handleReport } from './report/store.js';
import { scheduleLogRetentionSweep } from './retention.js';
import { tailSshLog } from './ssh-tail.js';
import { tailContainerLogs } from './tail.js';
import { handleVipExpiryWarnConnect } from './vip-expiry/warn.js';
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
  // SSH log sources carry a private key encrypted with APP_ENCRYPTION_KEY.
  // Without the key the worker still tails every panel-hosted container; the
  // external rows are skipped with one warning instead of a crash loop.
  let encryptionKey: Buffer | null = null;
  if (process.env.APP_ENCRYPTION_KEY) {
    encryptionKey = loadEncryptionKey(process.env.APP_ENCRYPTION_KEY);
  } else {
    log.warn('APP_ENCRYPTION_KEY is not set — SSH log sources of external servers are disabled');
  }
  const stopLogRetentionSweep = scheduleLogRetentionSweep({
    bridge,
    diag,
    log,
    // LOG-3 (#51): the servers whose expiring rotated logs must be archived
    // into the restic backup staging tree before the sweep deletes them.
    listArchiveServerIds: async () => {
      const rows = await db
        .select({ id: serverSettings.serverId })
        .from(serverSettings)
        .innerJoin(servers, eq(serverSettings.serverId, servers.id))
        .where(and(eq(serverSettings.archiveLogsToBackup, true), isNull(servers.deletedAt)));
      return rows.map((r) => r.id);
    },
  });

  const seedThreshold =
    Number(process.env.MATCH_SEED_ONLINE_THRESHOLD) || DEFAULT_SEED_ONLINE_THRESHOLD;

  const chatFlagDetector = new ChatFlagDetector(db);
  const bannedNameCache = new BannedNameRuleCache(db);
  const externalBanCache = new ExternalBanCache(db, redis);

  const manager = new TailManager((wanted) => {
    const { serverId, beaconPort } = wanted;
    log.info({ serverId, beaconPort, source: wanted.source.kind }, 'attaching log tail');
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
        // AUTO-4 (#75): answer in-game `!stats`/`!rules`/`!report` over RCON.
        // Independent of the chat-message record above; `!report` delegates the
        // report record itself to REPORT-1 via the ingestor's onReport path.
        handleChatCommand(db, redis, { serverId, chat }).catch((err) =>
          log.error({ err: (err as Error).message }, 'chat command handling failed'),
        );
        // AUTO-1 (#72): fire automation rules whose chat_keyword condition
        // matches this line (chat is not on the event stream the automation
        // worker reads, so it is evaluated here).
        handleAutomationChat(db, redis, { serverId, chat }).catch((err) =>
          log.error({ err: (err as Error).message }, 'automation chat handling failed'),
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
    const onLine = (line: string) => {
      const events = ingestor.ingest(line);
      for (const e of events) {
        persistEventEnvelope(db, e).catch((err) =>
          log.error({ err: (err as Error).message, type: e.type }, 'event persist failed'),
        );
        publish(redis, e).catch((err) =>
          log.error({ err: (err as Error).message, type: e.type }, 'publish failed'),
        );
        if (e.type === 'player.connected') {
          // Upsert the canonical identity first (PLAYER-1, #22) so the player
          // row exists before the ban handlers below read it — otherwise a
          // first-time connector is invisible to alt/external-ban enforcement
          // until the next RCON poll.
          handlePlayerConnected(db, e)
            .catch((err) =>
              log.error({ err: (err as Error).message }, 'player identity handling failed'),
            )
            .finally(() => {
              handleAltBanConnect(db, redis, e).catch((err) =>
                log.error({ err: (err as Error).message }, 'alt-ban handling failed'),
              );
              handleBannedNameEvent(db, redis, { serverId, event: e }, bannedNameCache).catch(
                (err) => log.error({ err: (err as Error).message }, 'banname handling failed'),
              );
              handleExternalBanConnect(db, redis, externalBanCache, { serverId, event: e }).catch(
                (err) => log.error({ err: (err as Error).message }, 'external-ban handling failed'),
              );
              handleVipExpiryWarnConnect(db, redis, { serverId, event: e }).catch((err) =>
                log.error({ err: (err as Error).message }, 'vip-expiry warn handling failed'),
              );
            });
        }
        if (e.type === 'player.name_changed') {
          handleBannedNameEvent(db, redis, { serverId, event: e }, bannedNameCache).catch((err) =>
            log.error({ err: (err as Error).message }, 'banname handling failed'),
          );
        }
      }
    };
    if (wanted.source.kind === 'ssh') {
      const src = wanted.source;
      const statusKey = logSourceStatusKey(serverId);
      let lines = 0;
      let lastLineAt: string | null = null;
      let lastStatus: { state: string; error: string | null; hostKeyFingerprint: string | null } = {
        state: 'connecting',
        error: null,
        hostKeyFingerprint: src.hostKeyFingerprint,
      };
      let lastWriteAt = 0;
      const writeStatus = () => {
        lastWriteAt = Date.now();
        redis
          .set(
            statusKey,
            JSON.stringify({
              state: lastStatus.state,
              ts: new Date().toISOString(),
              error: lastStatus.error,
              host_key_fingerprint: lastStatus.hostKeyFingerprint,
              lines,
              last_line_at: lastLineAt,
            }),
            'EX',
            600,
          )
          .catch((err) =>
            log.warn({ err: (err as Error).message }, 'log-source status write failed'),
          );
      };
      const abort = tailSshLog({
        serverId,
        host: src.host,
        port: src.port,
        username: src.username,
        privateKey: src.privateKey,
        logPath: src.logPath,
        expectedHostKeyFingerprint: src.hostKeyFingerprint,
        log,
        onLine: (line) => {
          lines += 1;
          lastLineAt = new Date().toISOString();
          onLine(line);
          if (Date.now() - lastWriteAt > 30_000) writeStatus();
        },
        onStatus: (status) => {
          lastStatus = status;
          writeStatus();
          diag
            .emit({
              component: 'worker-log-ingest',
              kind: status.state === 'connected' ? 'tail.started' : 'tail.stopped',
              severity: status.state === 'error' ? 'warn' : 'info',
              serverId,
              message: `ssh tail ${status.state} for ${src.username}@${src.host}:${src.port}${status.error ? ` (${status.error})` : ''}`,
              payload: {
                source: 'ssh',
                host: src.host,
                port: src.port,
                ...(status.error ? { error: status.error } : {}),
              },
            })
            .catch(() => undefined);
        },
        onHostKey: (fingerprint) => {
          // Trust on first use: pin the fingerprint so a later host-key change is refused.
          db.update(serverLogSources)
            .set({ hostKeyFingerprint: fingerprint, updatedAt: new Date() })
            .where(eq(serverLogSources.serverId, serverId))
            .catch((err) =>
              log.warn({ err: (err as Error).message, serverId }, 'host key pin failed'),
            );
        },
      });
      return {
        abort: () => {
          abort();
          redis.del(statusKey).catch(() => undefined);
        },
      };
    }
    const abort = tailContainerLogs({
      bridge,
      log,
      name: `squad-${serverId}`,
      onLine,
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
    // Panel-hosted containers are tailed through the bridge; external
    // servers (runtime='external') only when an enabled SSH log source is
    // configured for them — their SquadGame.log lives on another host.
    const rows = await db
      .select({
        id: servers.id,
        status: servers.status,
        beaconPort: serverSettings.beaconPort,
      })
      .from(servers)
      .innerJoin(serverSettings, eq(servers.id, serverSettings.serverId))
      .where(eq(servers.runtime, 'container'));
    const wanted: TailWanted[] = rows
      .filter((r) => r.status === 'running' || r.status === 'starting')
      .map((r) => ({ serverId: r.id, beaconPort: r.beaconPort, source: { kind: 'container' } }));
    if (encryptionKey) {
      const sshRows = await db
        .select({
          id: servers.id,
          beaconPort: serverSettings.beaconPort,
          host: serverLogSources.sshHost,
          port: serverLogSources.sshPort,
          username: serverLogSources.sshUser,
          blob: serverLogSources.sshPrivateKeyEncrypted,
          logPath: serverLogSources.logPath,
          hostKeyFingerprint: serverLogSources.hostKeyFingerprint,
          keyVersion: serverLogSources.keyVersion,
        })
        .from(serverLogSources)
        .innerJoin(servers, eq(servers.id, serverLogSources.serverId))
        .innerJoin(serverSettings, eq(servers.id, serverSettings.serverId))
        .where(
          and(
            eq(servers.runtime, 'external'),
            isNull(servers.deletedAt),
            eq(serverLogSources.enabled, true),
            eq(serverLogSources.kind, 'ssh'),
          ),
        );
      for (const r of sshRows) {
        try {
          const privateKey = decrypt(
            encryptionKey,
            deserialize(Buffer.from(r.blob as unknown as Buffer)),
          );
          wanted.push({
            serverId: r.id,
            beaconPort: r.beaconPort,
            source: {
              kind: 'ssh',
              host: r.host,
              port: r.port,
              username: r.username,
              privateKey,
              logPath: r.logPath,
              hostKeyFingerprint: r.hostKeyFingerprint,
              keyVersion: r.keyVersion,
            },
          });
        } catch (err) {
          log.error(
            { err: (err as Error).message, serverId: r.id },
            'log source key decrypt failed',
          );
        }
      }
    }
    const active = await dropCutoverServers(redis, wanted);
    manager.reconcile(active);
  }

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'log-ingest',
    statusFn: () => `tails=${manager.size()}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  let interval: NodeJS.Timeout | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      stopHeartbeat();
      stopLogRetentionSweep();
      if (interval) clearInterval(interval);
      manager.stopAll();
      await redis.quit().catch(() => undefined);
      await bridge.close();
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  await reconcile();
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;
  interval = setInterval(() => {
    reconcile().catch((err) => log.error({ err: (err as Error).message }, 'reconcile failed'));
  }, 15_000);

  log.info('worker-log-ingest ready');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
