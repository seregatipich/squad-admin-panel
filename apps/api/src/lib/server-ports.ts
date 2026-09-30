import type { DatabaseClient } from '@squad/db';
import { serverSettings, servers } from '@squad/db/schema';
import { and, eq, isNull, ne, or } from 'drizzle-orm';

/**
 * Cross-server port collision check shared by `POST /api/v1/servers`,
 * `PUT /api/v1/servers/:id/settings` and
 * `POST /api/v1/servers/archive/:id/restore`.
 *
 * Only active (not soft-deleted) `container` servers count: an archived
 * server holds no ports, and an external server lives on another host, so its
 * ports never collide with a container bound on this one.
 *
 * @param db - database handle.
 * @param ports - ports the caller is about to bind; any of them matching any
 *   of another server's game/query/beacon/RCON ports is a conflict.
 * @param excludeServerId - the server being edited, whose own ports never
 *   conflict with themselves.
 * @returns whether another active container server already uses one of `ports`.
 */
export async function hasContainerPortConflict(
  db: Pick<DatabaseClient, 'select'>,
  ports: readonly number[],
  excludeServerId?: string,
): Promise<boolean> {
  if (ports.length === 0) return false;
  const rows = await db
    .select({ serverId: serverSettings.serverId })
    .from(serverSettings)
    .innerJoin(servers, eq(serverSettings.serverId, servers.id))
    .where(
      and(
        excludeServerId ? ne(serverSettings.serverId, excludeServerId) : undefined,
        isNull(servers.deletedAt),
        eq(servers.runtime, 'container'),
        or(
          ...ports.map((p) =>
            or(
              eq(serverSettings.gamePort, p),
              eq(serverSettings.queryPort, p),
              eq(serverSettings.beaconPort, p),
              eq(serverSettings.rconPort, p),
            ),
          ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
