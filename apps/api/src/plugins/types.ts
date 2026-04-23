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
    /**
     * Spawns a fresh short-lived BridgeClient. Long-running streaming calls
     * (journalctl_follow, steamcmd_run watching an install) use this so the
     * dedicated TCP connection can be torn down when the browser-side
     * WebSocket closes, which in turn signals the bridge subprocess to exit.
     * In tests this can be decorated with a stub.
     */
    makeBridgeClient: () => BridgeClient;
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
