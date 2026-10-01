/** Params schema and container helpers shared by the server lifecycle route modules. */

import type Redis from 'ioredis';
import { z } from 'zod';

/** Route params of the server routes keyed by server id. */
export const serverIdParams = z.object({ id: z.string().uuid() });

/** Docker container name of a managed server. */
export function containerName(id: string) {
  return `squad-${id}`;
}

/**
 * Whether a depot update holds the `depot:updating` lock (taken by
 * server-update.ts and depot.ts). Every Squad container mounts the one shared
 * depot volume, so starting a container while SteamCMD rewrites it would boot
 * the server on a half-written install (#20).
 */
export async function isDepotUpdating(redis: Redis): Promise<boolean> {
  return (await redis.get('depot:updating')) !== null;
}
