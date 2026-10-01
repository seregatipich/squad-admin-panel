/** Option and result types of the integration harness. */

import type { DatabaseClient } from '@squad/db';
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import type { FakeBridge } from './fake-bridge.js';

export interface BuildAppOptions {
  /** A fake bridge instance; defaults to `makeFakeBridge()`. */
  bridge?: FakeBridge;
  /** Whether to seed an owner player (roles come from migration 0009). */
  seedOwner?: { steamId64: bigint; canonicalName?: string };
  /**
   * Whether to seed an unloginable backup Owner alongside `seedOwner`.
   * Defaults to false for a production-like single-Owner fixture. Enable only
   * when a test intentionally demotes its authenticated Owner to exercise RBAC
   * — migration 0107's last-Owner guard trigger otherwise rejects that update.
   */
  seedOwnerGuard?: boolean;
  /** Whether to run status-reconciler + other heavy plugins. Off by default. */
  withStatusReconciler?: boolean;
  /**
   * Run against the already-migrated shared `public` schema instead of a
   * fresh isolated schema. Requires the target database to be migrated ahead
   * of time (e.g. `db:migrate`). Use for suites that need the hand-authored
   * wave-5 tables, whose `public`-qualified DDL cannot be replayed into an
   * isolated schema. Isolate such suites with their own dedicated database.
   */
  reusePublicSchema?: boolean;
  /** DISCORD-6 (#153): raw Ed25519 public key the interactions route verifies against. */
  discordInteractionsPublicKey?: string;
}

export interface IntegrationHarness {
  app: FastifyInstance;
  db: DatabaseClient;
  redis: Redis;
  bridge: FakeBridge;
  url: string;
  schema: string;
  mediaDir: string;
  cleanup: () => Promise<void>;
  seed: {
    ownerSteamId64?: bigint;
    ownerPlayerId?: string;
  };
}
