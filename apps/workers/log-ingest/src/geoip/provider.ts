import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createMmdbLookup,
  type DatabaseClient,
  GEOLITE2_CITY_EDITION,
  type GeoLookup,
  refreshGeoLite2Db,
  shouldRefreshGeoIpDb,
} from '@squad/db';
import { GEOIP_SETTINGS_SINGLETON_ID, geoipSettings } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt, deserialize } from '../crypto.js';
import { extractMmdbFromTarGz } from './archive.js';

/** How often the settings row is re-read so a toggle or a new database applies without a restart. */
export const GEOIP_SETTINGS_CACHE_MS = 60_000;

export interface GeoIpProviderOptions {
  db: DatabaseClient;
  /** Key that decrypts the stored MaxMind license key; without it the database is never downloaded. */
  encryptionKey: Buffer | null;
  /** Writable directory the downloaded `.mmdb` is stored in. */
  dataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onError?: (message: string, meta: Record<string, unknown>) => void;
}

interface LoadedLookup {
  dbPath: string;
  lastRefreshedAt: number | null;
  lookup: GeoLookup | null;
}

/**
 * Supplies the GeoIP lookup used when a connecting player's IP is recorded and
 * keeps the GeoLite2 database fresh.
 *
 * Both halves follow the singleton `geoip_settings` row that the API writes:
 * nothing happens unless `enabled` is set, the lookup is reloaded whenever
 * `dbPath`/`lastRefreshedAt` change, and a failure of either half is reported
 * through `onError` and never reaches the log-ingest hot path.
 */
export class GeoIpProvider {
  private loaded: LoadedLookup | null = null;
  private settingsCheckedAt = 0;

  constructor(private readonly options: GeoIpProviderOptions) {}

  /**
   * Returns the current lookup, or `null` while GeoIP is disabled or has no
   * readable database (the caller then records the IP without geo fields).
   */
  async getLookup(): Promise<GeoLookup | null> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (this.loaded && now - this.settingsCheckedAt < GEOIP_SETTINGS_CACHE_MS) {
      return this.loaded.lookup;
    }
    this.settingsCheckedAt = now;
    try {
      const [row] = await this.options.db
        .select({
          enabled: geoipSettings.enabled,
          dbPath: geoipSettings.dbPath,
          lastRefreshedAt: geoipSettings.lastRefreshedAt,
        })
        .from(geoipSettings)
        .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID))
        .limit(1);
      if (!row?.enabled || !row.dbPath) {
        this.loaded = { dbPath: '', lastRefreshedAt: null, lookup: null };
        return null;
      }
      const refreshedAt = row.lastRefreshedAt?.getTime() ?? null;
      if (this.loaded?.dbPath !== row.dbPath || this.loaded.lastRefreshedAt !== refreshedAt) {
        this.loaded = {
          dbPath: row.dbPath,
          lastRefreshedAt: refreshedAt,
          lookup: await createMmdbLookup(row.dbPath),
        };
      }
      return this.loaded.lookup;
    } catch (err) {
      this.options.onError?.('geoip settings read failed', { err: (err as Error).message });
      return this.loaded?.lookup ?? null;
    }
  }

  /**
   * Downloads the GeoLite2-City database when GeoIP is enabled, credentials are
   * stored and the database is missing or older than the refresh interval, then
   * records `dbPath`/`lastRefreshedAt`. Never throws.
   *
   * @returns `true` when a fresh database was stored
   */
  async refreshIfDue(): Promise<boolean> {
    const { db, encryptionKey, dataDir, onError } = this.options;
    const now = (this.options.now ?? (() => new Date()))();
    try {
      const [row] = await db
        .select()
        .from(geoipSettings)
        .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID))
        .limit(1);
      if (!row?.enabled || !row.accountId || !row.licenseKeyEncrypted) return false;
      if (!encryptionKey) return false;
      if (row.dbPath && !shouldRefreshGeoIpDb(row.lastRefreshedAt, now)) return false;

      const licenseKey = decrypt(encryptionKey, deserialize(row.licenseKeyEncrypted));
      const result = await refreshGeoLite2Db({
        credentials: { accountId: row.accountId, licenseKey },
        fetchImpl: (url, init) => (this.options.fetchImpl ?? fetch)(url, init),
        persistArchive: async (archive) => {
          const database = extractMmdbFromTarGz(archive);
          await mkdir(dataDir, { recursive: true });
          const target = join(dataDir, `${GEOLITE2_CITY_EDITION}.mmdb`);
          const partial = `${target}.partial`;
          await writeFile(partial, database);
          await rename(partial, target);
          return target;
        },
      });
      if (result.status !== 'ok') {
        onError?.('geoip refresh skipped', { ...result });
        return false;
      }
      await db
        .update(geoipSettings)
        .set({ dbPath: result.dbPath, lastRefreshedAt: now })
        .where(eq(geoipSettings.id, GEOIP_SETTINGS_SINGLETON_ID));
      return true;
    } catch (err) {
      onError?.('geoip refresh failed', { err: (err as Error).message });
      return false;
    }
  }
}
