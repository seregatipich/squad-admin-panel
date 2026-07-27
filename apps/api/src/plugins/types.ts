import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import type { SessionScope } from '@squad/db/schema';
import type { PermissionKey } from '@squad/shared-config';
import type Redis from 'ioredis';
import type { AppConfig } from '../config.js';
import type { PermissionContext } from '../lib/rbac.js';
import type { RconClient } from '../lib/rcon.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    permissions?: readonly PermissionKey[];
    audit?: { action: string; resource: string } | false;
    requireSetupComplete?: boolean;
    /**
     * Opts the route into being reachable by a `self_service`-scoped session
     * (VIPSUB-5, #171) — a Steam login for a player whose role has no
     * `panel_access`. Every other route treats such a session as anonymous
     * (`apps/api/src/plugins/auth.ts`), so a self-service route MUST scope all
     * of its data to `req.user.playerId` and never accept a foreign id.
     */
    selfService?: boolean;
  }
  interface FastifyInstance {
    db: DatabaseClient;
    redis: Redis;
    bridge: BridgeClient;
    encryptionKey: Buffer;
    config: AppConfig;
    rcon: RconClient;
    makeBridgeClient: () => BridgeClient;
  }
  interface FastifyRequest {
    session?: { id: string; playerId: string; scope: SessionScope };
    user?: {
      playerId: string;
      steamId64: bigint | null;
      canonicalName: string;
      avatarUrl: string | null;
      permissions: PermissionContext;
    };
    apiTokenId?: string;
    requestId: string;
    /**
     * Optional before/after snapshots for the declarative audit hook
     * (`plugins/audit.ts`). A route that declares `config.audit` may set this
     * during the handler; the hook then persists the snapshots alongside the
     * entry it was already going to write, instead of leaving them null.
     *
     * This exists so a route can satisfy "the change is visible in audit_log
     * with before/after" without opting out of `config.audit` — the CI guard in
     * `test/audit-coverage.test.ts` only accepts `audit: false` for a short
     * allowlist of auth callbacks and self-audited service endpoints.
     *
     * `targetId` overrides the id the hook derives from route params, which is
     * how a POST (no `:id` param) can still name the row it created.
     */
    auditSnapshots?: { before?: unknown; after?: unknown; targetId?: string | null };
  }
}
