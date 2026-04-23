import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import type { PermissionKey } from '@squad/shared-config';
import type Redis from 'ioredis';
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
  }
  interface FastifyRequest {
    session?: { id: string; userId: string };
    user?: {
      id: string;
      email: string;
      displayName: string | null;
      permissions: PermissionContext;
    };
    requestId: string;
  }
}
