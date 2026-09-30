import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMmdbLookup } from '../src/geoip/mmdb.js';
import {
  buildGeoLite2BasicAuthHeader,
  buildGeoLite2DownloadUrl,
  GEOIP_MAX_ARCHIVE_BYTES,
  type RefreshGeoLite2Options,
  refreshGeoLite2Db,
  shouldRefreshGeoIpDb,
} from '../src/geoip/refresh.js';
import { type GeoLookup, mapMaxmindCity, NULL_GEO, resolveGeo } from '../src/geoip/resolver.js';

describe('resolveGeo', () => {
  it('returns all-null geo when no lookup is configured', () => {
    expect(resolveGeo(null, '203.0.113.5')).toEqual(NULL_GEO);
    expect(resolveGeo(undefined, '203.0.113.5')).toEqual(NULL_GEO);
  });

  it('returns all-null geo when the lookup finds nothing', () => {
    const lookup: GeoLookup = { lookup: () => null };
    expect(resolveGeo(lookup, '10.0.0.1')).toEqual(NULL_GEO);
  });

  it('returns all-null geo when the lookup throws', () => {
    const lookup: GeoLookup = {
      lookup: () => {
        throw new Error('reader closed');
      },
    };
    expect(resolveGeo(lookup, '10.0.0.1')).toEqual(NULL_GEO);
  });

  it('passes through the geo fields when the lookup resolves', () => {
    const lookup: GeoLookup = {
      lookup: () => ({
        countryCode: 'DE',
        countryName: 'Germany',
        region: 'Berlin',
        city: 'Berlin',
        timezoneOffset: 'Europe/Berlin',
        latitude: 52.52,
        longitude: 13.405,
      }),
    };
    expect(resolveGeo(lookup, '203.0.113.9')).toMatchObject({
      countryCode: 'DE',
      city: 'Berlin',
    });
  });

  it('does not leak mutations back into the frozen NULL_GEO singleton', () => {
    const result = resolveGeo(null, '203.0.113.5');
    result.countryCode = 'XX';
    expect(NULL_GEO.countryCode).toBeNull();
  });
});

describe('mapMaxmindCity', () => {
  it('maps a full City response to geo fields (last subdivision wins)', () => {
    expect(
      mapMaxmindCity({
        country: { iso_code: 'US', names: { en: 'United States' } },
        subdivisions: [{ names: { en: 'California' } }, { names: { en: 'Los Angeles County' } }],
        city: { names: { en: 'Los Angeles' } },
        location: { time_zone: 'America/Los_Angeles', latitude: 34.05, longitude: -118.24 },
      }),
    ).toEqual({
      countryCode: 'US',
      countryName: 'United States',
      region: 'Los Angeles County',
      city: 'Los Angeles',
      timezoneOffset: 'America/Los_Angeles',
      latitude: 34.05,
      longitude: -118.24,
    });
  });

  it('tolerates partial responses without throwing', () => {
    expect(mapMaxmindCity({ country: { iso_code: 'FR' } })).toMatchObject({
      countryCode: 'FR',
      countryName: null,
      city: null,
      latitude: null,
    });
    expect(mapMaxmindCity(null)).toEqual(NULL_GEO);
    expect(mapMaxmindCity(undefined)).toEqual(NULL_GEO);
  });
});

describe('createMmdbLookup', () => {
  it('returns null when no db path is configured', async () => {
    expect(await createMmdbLookup(null)).toBeNull();
    expect(await createMmdbLookup(undefined)).toBeNull();
  });

  it('returns null when the db file does not exist', async () => {
    expect(await createMmdbLookup('/nonexistent/path/GeoLite2-City.mmdb')).toBeNull();
  });

  it('returns null when the file is not a valid mmdb database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mmdb-'));
    try {
      const dbPath = join(dir, 'GeoLite2-City.mmdb');
      await writeFile(dbPath, 'not a maxmind database');
      expect(await createMmdbLookup(dbPath)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildGeoLite2DownloadUrl', () => {
  it('targets the current per-edition download endpoint with no credentials in the URL', () => {
    const url = buildGeoLite2DownloadUrl();
    expect(url).toBe(
      'https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz',
    );
    // Regression guard for the legacy `app/geoip_download?license_key=...`
    // endpoint, which leaked the license key into the query string (and so
    // into access logs, proxies and request history).
    expect(url).not.toContain('license_key');
  });
});

describe('buildGeoLite2BasicAuthHeader', () => {
  it('base64-encodes accountId:licenseKey for HTTP Basic Auth', () => {
    const header = buildGeoLite2BasicAuthHeader('acct-1', 'lic-1');
    expect(header).toBe(`Basic ${Buffer.from('acct-1:lic-1').toString('base64')}`);
  });
});

describe('shouldRefreshGeoIpDb', () => {
  const now = new Date('2026-07-05T00:00:00Z');

  it('refreshes when never refreshed', () => {
    expect(shouldRefreshGeoIpDb(null, now)).toBe(true);
  });

  it('refreshes when the db is at least a week old', () => {
    expect(shouldRefreshGeoIpDb(new Date('2026-06-27T00:00:00Z'), now)).toBe(true);
  });

  it('does not refresh a fresh db', () => {
    expect(shouldRefreshGeoIpDb(new Date('2026-07-03T00:00:00Z'), now)).toBe(false);
  });
});

describe('refreshGeoLite2Db', () => {
  function makeOptions(overrides: Partial<RefreshGeoLite2Options>): RefreshGeoLite2Options {
    return {
      credentials: { accountId: 'acct-1', licenseKey: 'lic-1' },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
      persistArchive: async () => '/var/lib/geoip/GeoLite2-City.mmdb',
      ...overrides,
    };
  }

  it('skips the download when no license key is present', async () => {
    const result = await refreshGeoLite2Db(
      makeOptions({ credentials: { accountId: null, licenseKey: null } }),
    );
    expect(result).toEqual({ status: 'skipped_no_key' });
  });

  it('skips the download when the account id is missing, even with a license key', async () => {
    // MaxMind's current API authenticates with account id + license key
    // together; a license key alone can no longer authenticate.
    const result = await refreshGeoLite2Db(
      makeOptions({ credentials: { accountId: null, licenseKey: 'lic-1' } }),
    );
    expect(result).toEqual({ status: 'skipped_no_key' });
  });

  it('sends credentials as a Basic Auth header, never in the URL', async () => {
    let requestedUrl = '';
    let sentHeaders: Record<string, string> | undefined;
    await refreshGeoLite2Db(
      makeOptions({
        fetchImpl: async (url, init) => {
          requestedUrl = url;
          sentHeaders = init?.headers;
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          };
        },
      }),
    );
    expect(requestedUrl).not.toContain('lic-1');
    expect(sentHeaders?.Authorization).toBe(buildGeoLite2BasicAuthHeader('acct-1', 'lic-1'));
  });

  it('aborts the request once the configured timeout elapses', async () => {
    let receivedSignal: AbortSignal | undefined;
    await refreshGeoLite2Db(
      makeOptions({
        timeoutMs: 5,
        fetchImpl: async (_url, init) => {
          receivedSignal = init?.signal;
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          };
        },
      }),
    );
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an archive whose declared Content-Length exceeds the cap, before buffering it', async () => {
    let bufferedBody = false;
    const result = await refreshGeoLite2Db(
      makeOptions({
        maxArchiveBytes: 10,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name === 'content-length' ? '999' : null) },
          arrayBuffer: async () => {
            bufferedBody = true;
            return new Uint8Array(999).buffer;
          },
        }),
      }),
    );
    expect(result).toEqual({ status: 'archive_too_large', contentLength: 999 });
    expect(bufferedBody).toBe(false);
  });

  it('rejects an oversized archive even without a Content-Length header', async () => {
    const result = await refreshGeoLite2Db(
      makeOptions({
        maxArchiveBytes: 2,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      }),
    );
    expect(result).toEqual({ status: 'archive_too_large', contentLength: 3 });
  });

  it('accepts an archive at or below the default cap', () => {
    expect(GEOIP_MAX_ARCHIVE_BYTES).toBeGreaterThan(100 * 1024 * 1024);
  });

  it('reports a download failure without persisting', async () => {
    let persisted = false;
    const result = await refreshGeoLite2Db(
      makeOptions({
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          arrayBuffer: async () => new ArrayBuffer(0),
        }),
        persistArchive: async () => {
          persisted = true;
          return 'x';
        },
      }),
    );
    expect(result).toEqual({ status: 'download_failed', httpStatus: 401 });
    expect(persisted).toBe(false);
  });

  it('persists the archive and returns the resulting db path', async () => {
    let receivedBytes = 0;
    const result = await refreshGeoLite2Db(
      makeOptions({
        persistArchive: async (archive) => {
          receivedBytes = archive.byteLength;
          return '/var/lib/geoip/GeoLite2-City.mmdb';
        },
      }),
    );
    expect(result).toEqual({ status: 'ok', dbPath: '/var/lib/geoip/GeoLite2-City.mmdb' });
    expect(receivedBytes).toBe(3);
  });
});
