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
  }
}
