import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import type { SessionScope } from '@squad/db/schema';
import type { PermissionKey } from '@squad/shared-config';
import type Redis from 'ioredis';
import type { AppConfig } from '../config.js';
import type { PermissionContext, RoleFlagName } from '../lib/rbac.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    permissions?: readonly PermissionKey[];
    /**
     * Role capabilities (e.g. `canManageClans`, `panelAccess`) the caller must
     * all hold, for routes gated on a role flag that has no `permissions` key.
     * Enforced by the global hook in `plugins/auth.ts` right after
     * `permissions`; a miss answers 403 `{ error: 'forbidden', required }`
     * where `required` is the snake_case flag name.
     */
    roleFlags?: readonly RoleFlagName[];
    /**
     * Audit policy of the route (TZ §17.12, enforced by
     * `test/audit-coverage.test.ts` for every mutating route):
     * - `{ action, resource }` — `plugins/audit.ts` writes one audit_log row
     *   after the response;
     * - `'manual'` — the handler writes its own audit_log rows with
     *   `writeAuditEntry` (e.g. several rows, or only on success);
     * - `false` — not audited: reads, or an allowlisted machine integration.
     */
    audit?: { action: string; resource: string } | 'manual' | false;
    requireSetupComplete?: boolean;
    /**
     * Opts the route into being reachable by a `self_service`-scoped session
     * (VIPSUB-5, #171) — a Steam login for a player whose role has no
     * `panel_access`. Every other route treats such a session as anonymous
     * (`apps/api/src/plugins/auth.ts`), so a self-service route MUST scope all
     * of its data to `req.user.playerId` and never accept a foreign id.
     */
    selfService?: boolean;
    /**
     * Explicitly opts a route out of authentication (#246). The global
     * `onRequest` hook in `apps/api/src/plugins/auth.ts` is fail-closed: any
     * route without this flag requires `req.user` to be set, even if it also
     * declares no `permissions`. Set this only for routes that are
     * deliberately public (health probes, signature-gated webhooks, public
     * data portals) — never as a default.
     */
    public?: boolean;
  }
  interface FastifyInstance {
    db: DatabaseClient;
    redis: Redis;
    bridge: BridgeClient;
    encryptionKey: Buffer;
    config: AppConfig;
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
     * `test/audit-coverage.test.ts` only accepts `audit: false` on a mutating
     * route for its short allowlist of machine integrations.
     *
     * `targetId` overrides the id the hook derives from route params, which is
     * how a POST (no `:id` param) can still name the row it created.
     */
    auditSnapshots?: { before?: unknown; after?: unknown; targetId?: string | null };
  }
}
