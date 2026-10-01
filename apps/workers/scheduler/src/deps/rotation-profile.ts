import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { rotationProfiles, servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { RotationProfileEntry, RotationProfileTickDeps } from '../rotation-profile-tick.js';
import { writeSystemAuditEntry } from './shared.js';

/** Loads profiles together with each server's configured timezone. */
export async function loadRotationProfiles(db: DatabaseClient): Promise<RotationProfileEntry[]> {
  const rows = await db
    .select({
      id: rotationProfiles.id,
      serverId: rotationProfiles.serverId,
      serverTimezone: servers.timezone,
      name: rotationProfiles.name,
      weekday: rotationProfiles.weekday,
      layers: rotationProfiles.layers,
      lastAppliedAt: rotationProfiles.lastAppliedAt,
    })
    .from(rotationProfiles)
    .innerJoin(servers, eq(servers.id, rotationProfiles.serverId))
    // Profiles are applied by rewriting LayerRotation.cfg through the bridge,
    // which only exists for panel-hosted (container) servers.
    .where(and(isNull(servers.deletedAt), eq(servers.runtime, 'container')));
  return rows;
}

export async function setRotationProfileLastAppliedAt(
  db: DatabaseClient,
  profileId: string,
  appliedAt: Date,
): Promise<void> {
  await db
    .update(rotationProfiles)
    .set({ lastAppliedAt: appliedAt, updatedAt: new Date() })
    .where(eq(rotationProfiles.id, profileId));
}

export function createRotationProfileDeps(
  db: DatabaseClient,
  bridge: Pick<BridgeClient, 'fileRead' | 'fileAtomicWrite'>,
): Omit<RotationProfileTickDeps, 'now' | 'diag'> {
  return {
    loadProfiles: () => loadRotationProfiles(db),
    bridge,
    setLastAppliedAt: (profileId, appliedAt) =>
      setRotationProfileLastAppliedAt(db, profileId, appliedAt),
    writeAuditEntry: (entry) => writeSystemAuditEntry(db, entry),
  };
}
