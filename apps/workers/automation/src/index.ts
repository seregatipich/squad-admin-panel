import { createDatabaseClient } from '@squad/db';
import { startHeartbeat } from '@squad/shared-config';
import type { AutomationRuleInput } from '@squad/shared-types';
import { runMatch } from '@squad/shared-types';
import Redis from 'ioredis';
import pino from 'pino';
import { runDispatchLoop } from './dispatch.js';
import { BUILTIN_PLUGINS, loadPlugins } from './loader.js';
import { PluginRegistry } from './registry.js';
import {
  createRunMatchDeps,
  loadEnabledAutomationRules,
  resolvePlayerFlags,
} from './rules/deps.js';
import { processAutomationEnvelope } from './rules/runtime.js';

/** How long the enabled-rules snapshot is reused before reloading from the DB. */
const RULES_CACHE_TTL_MS = 15_000;

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-automation' },
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return value;
}

/**
 * Plugin/event-hook host worker (INT-4). Loads the compiled-in plugin set,
 * then runs a Redis-stream consumer that dispatches every EventEnvelope
 * (published by worker-log-ingest / worker-rcon) to plugins subscribed to
 * its kind. See `dispatch.ts` for the consumer loop and permission gate.
 */
async function main() {
  const db = createDatabaseClient(requiredEnv('DATABASE_URL'));
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const registry = new PluginRegistry();
  loadPlugins(registry, BUILTIN_PLUGINS);
  log.info({ plugins: registry.list().map((p) => p.id) }, 'plugins loaded');

  // AUTO-1 (#72): evaluate the trigger rules against each event. Enabled rules
  // are cached briefly so a busy event stream does not hammer the DB.
  const runMatchDeps = createRunMatchDeps(db, redis, log);
  let rulesCache: { at: number; rules: AutomationRuleInput[] } | null = null;
  const loadRules = async (): Promise<AutomationRuleInput[]> => {
    if (rulesCache && Date.now() - rulesCache.at < RULES_CACHE_TTL_MS) return rulesCache.rules;
    const rules = await loadEnabledAutomationRules(db);
    rulesCache = { at: Date.now(), rules };
    return rules;
  };
  const runtimeDeps = {
    loadRules,
    resolvePlayerFlags: (ref: { steamId64: string | null; eosId: string | null }) =>
      resolvePlayerFlags(db, ref),
    runMatch: (match: Parameters<typeof runMatch>[1], opts: { dryRun: boolean }) =>
      runMatch(runMatchDeps, match, opts),
    redis,
    log,
  };

  let stopped = false;
  const dispatchLoop = runDispatchLoop({
    redis,
    registry,
    log,
    shouldStop: () => stopped,
    onEnvelope: (envelope) =>
      processAutomationEnvelope(runtimeDeps, envelope).then(() => undefined),
  }).catch((err) => {
    log.error({ err: (err as Error).message }, 'dispatch loop crashed');
  });

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'automation',
    statusFn: () => `plugins=${registry.list().length}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopped = true;
    stopHeartbeat();
    await dispatchLoop;
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  log.info('worker-automation ready');
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
