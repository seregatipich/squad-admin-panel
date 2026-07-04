import { filterCutoverServers } from '@squad/shared-config';

export async function dropCutoverServers<T extends { serverId: string }>(
  redis: Parameters<typeof filterCutoverServers>[0],
  wanted: T[],
): Promise<T[]> {
  const { legacy } = await filterCutoverServers(
    redis,
    wanted.map((w) => w.serverId),
  );
  const keep = new Set(legacy);
  return wanted.filter((w) => keep.has(w.serverId));
}
