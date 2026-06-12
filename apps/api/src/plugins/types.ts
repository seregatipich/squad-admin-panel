import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import type { PermissionKey } from '@squad/shared-config';
import type Redis from 'ioredis';
import type { AppConfig } from '../config.js';
import type { PermissionContext } from '../lib/rbac.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    permissions?: readonly PermissionKey[];
    audit?: { action: string; resource: string } | false;
    requireSetupComplete?: boolean;
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
    session?: { id: string; playerId: string };
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
