import { detectGeoAnomalies, type GeoObservation } from '@squad/db';
import { geoipSettings, playerIpHistory } from '@squad/db/schema';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { panelGuard } from '../lib/panel-guard.js';

const playerIdParams = z.object({ playerId: z.string().uuid() });
const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const IP_HISTORY_CAP = 500;
const FEED_CANDIDATE_CAP = 500;

interface GeoConfig {
  switchWindowHours: number;
  multiCountryThreshold: number;
}

interface IpRow {
  ip: unknown;
  countryCode: string | null;
  countryName: string | null;
  latitude: number | null;
  longitude: number | null;
  lastSeenAt: Date;
}

function toObservations(rows: IpRow[]): GeoObservation[] {
  return rows.map((row) => ({
    countryCode: row.countryCode,
    countryName: row.countryName,
    observedAt: row.lastSeenAt,
  }));
}

/**
 * Whether the caller may see raw IPs and the per-IP coordinates derived from
 * them. Mirrors `players.ts` (ALT-8, #126): panel access alone does not imply
 * IP visibility, and an API token needs the `player:view_ips` scope (#10).
 */
function canViewIps(req: FastifyRequest): boolean {
  return req.user?.permissions.permissions.has('player:view_ips') ?? false;
}

/**
 * Builds the anomaly summary for one player's IP history.
 *
 * @param rows - The player's `player_ip_history` rows, newest first.
 * @param config - Detection thresholds from `geoip_settings`.
 * @param includePoints - When false, `points` (raw IPs plus precise
 *   coordinates) is returned empty; the country-level summary is kept, as
 *   `players.ts` exposes countries without `player:view_ips` too.
 */
function serializeAnomalies(rows: IpRow[], config: GeoConfig, includePoints: boolean) {
  const result = detectGeoAnomalies(toObservations(rows), config);
  return {
    config: {
      country_switch_window_hours: config.switchWindowHours,
      multi_country_threshold: config.multiCountryThreshold,
    },
    distinct_country_count: result.distinctCountryCount,
    multi_country: result.multiCountry,
    has_recent_switch: result.hasRecentSwitch,
    switches: result.switches.map((entry) => ({
      from_country_code: entry.fromCountryCode,
      from_country_name: entry.fromCountryName,
      to_country_code: entry.toCountryCode,
      to_country_name: entry.toCountryName,
      from_observed_at: entry.fromObservedAt.toISOString(),
      to_observed_at: entry.toObservedAt.toISOString(),
      gap_hours: Math.round(entry.gapHours * 10) / 10,
      within_window: entry.withinWindow,
    })),
    distinct_countries: result.distinctCountries.map((entry) => ({
      country_code: entry.countryCode,
      country_name: entry.countryName,
      first_observed_at: entry.firstObservedAt.toISOString(),
      last_observed_at: entry.lastObservedAt.toISOString(),
      observation_count: entry.observationCount,
    })),
    points: (includePoints ? rows : [])
      .filter((row) => row.latitude != null && row.longitude != null)
      .map((row) => ({
        ip: String(row.ip),
        country_code: row.countryCode,
        country_name: row.countryName,
        latitude: row.latitude,
        longitude: row.longitude,
        last_seen_at: row.lastSeenAt.toISOString(),
      })),
  };
}

const playerGeoAnomaliesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadConfig(): Promise<GeoConfig> {
    const [row] = await app.db
      .select({
        switchWindowHours: geoipSettings.countrySwitchWindowHours,
        multiCountryThreshold: geoipSettings.multiCountryThreshold,
      })
      .from(geoipSettings)
      .limit(1);
    return {
      switchWindowHours: row?.switchWindowHours ?? 24,
      multiCountryThreshold: row?.multiCountryThreshold ?? 3,
    };
  }

  fast.get(
    '/api/v1/players/:playerId/geo-anomalies',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const config = await loadConfig();
      const rows = (await app.db
        .select({
          ip: playerIpHistory.ip,
          countryCode: playerIpHistory.countryCode,
          countryName: playerIpHistory.countryName,
          latitude: playerIpHistory.latitude,
          longitude: playerIpHistory.longitude,
          lastSeenAt: playerIpHistory.lastSeenAt,
        })
        .from(playerIpHistory)
        .where(eq(playerIpHistory.playerId, req.params.playerId))
        .orderBy(desc(playerIpHistory.lastSeenAt))
        .limit(IP_HISTORY_CAP)) as IpRow[];

      return serializeAnomalies(rows, config, canViewIps(req));
    },
  );

  fast.get(
    '/api/v1/geo-anomalies',
    { schema: { querystring: feedQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const config = await loadConfig();
      const includePoints = canViewIps(req);
      const candidates = await app.db
        .select({
          playerId: playerIpHistory.playerId,
          countryCount: sql<number>`COUNT(DISTINCT ${playerIpHistory.countryCode})::int`,
        })
        .from(playerIpHistory)
        .where(isNotNull(playerIpHistory.countryCode))
        .groupBy(playerIpHistory.playerId)
        .having(sql`COUNT(DISTINCT ${playerIpHistory.countryCode}) > 1`)
        .limit(FEED_CANDIDATE_CAP);

      const items: Array<{ player_id: string } & ReturnType<typeof serializeAnomalies>> = [];
      for (const candidate of candidates) {
        const rows = (await app.db
          .select({
            ip: playerIpHistory.ip,
            countryCode: playerIpHistory.countryCode,
            countryName: playerIpHistory.countryName,
            latitude: playerIpHistory.latitude,
            longitude: playerIpHistory.longitude,
            lastSeenAt: playerIpHistory.lastSeenAt,
          })
          .from(playerIpHistory)
          .where(eq(playerIpHistory.playerId, candidate.playerId))
          .orderBy(desc(playerIpHistory.lastSeenAt))
          .limit(IP_HISTORY_CAP)) as IpRow[];
        const serialized = serializeAnomalies(rows, config, includePoints);
        if (!serialized.multi_country && !serialized.has_recent_switch) continue;
        items.push({ player_id: candidate.playerId, ...serialized });
      }

      items.sort((a, b) => {
        if (a.has_recent_switch !== b.has_recent_switch) return a.has_recent_switch ? -1 : 1;
        return b.distinct_country_count - a.distinct_country_count;
      });

      return { items: items.slice(0, req.query.limit), total: items.length };
    },
  );
};

export default playerGeoAnomaliesRoutes;
