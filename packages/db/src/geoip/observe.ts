import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { playerIpHistory } from '../schema/player-ip-history.js';
import { players } from '../schema/players.js';
import type { GeoFields } from './resolver.js';
import { NULL_GEO } from './resolver.js';

export interface IpObservationInput {
  playerId: string;
  ip: string;
  geo?: GeoFields;
  observedAt?: Date;
}

export async function recordIpObservation(
  db: DatabaseClient,
  input: IpObservationInput,
): Promise<void> {
  const now = input.observedAt ?? new Date();
  const geo = input.geo ?? NULL_GEO;

  await db
    .insert(playerIpHistory)
    .values({
      playerId: input.playerId,
      ip: input.ip,
      countryCode: geo.countryCode,
      countryName: geo.countryName,
      region: geo.region,
      city: geo.city,
      timezoneOffset: geo.timezoneOffset,
      latitude: geo.latitude,
      longitude: geo.longitude,
      firstSeenAt: now,
      lastSeenAt: now,
      observationCount: 1,
    })
    .onConflictDoUpdate({
      target: [playerIpHistory.playerId, playerIpHistory.ip],
      set: {
        lastSeenAt: now,
        observationCount: sql`${playerIpHistory.observationCount} + 1`,
      },
    });

  await db.update(players).set({ lastKnownIp: input.ip }).where(eq(players.id, input.playerId));
}
