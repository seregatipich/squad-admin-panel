export const GEOLITE2_CITY_EDITION = 'GeoLite2-City';
export const GEOIP_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function buildGeoLite2DownloadUrl(licenseKey: string): string {
  const params = new URLSearchParams({
    edition_id: GEOLITE2_CITY_EDITION,
    license_key: licenseKey,
    suffix: 'tar.gz',
  });
  return `https://download.maxmind.com/app/geoip_download?${params.toString()}`;
}

export function shouldRefreshGeoIpDb(lastRefreshedAt: Date | null, now: Date): boolean {
  if (!lastRefreshedAt) return true;
  return now.getTime() - lastRefreshedAt.getTime() >= GEOIP_REFRESH_INTERVAL_MS;
}

export interface GeoIpCredentials {
  accountId: string | null;
  licenseKey: string | null;
}

export interface RefreshGeoLite2Options {
  credentials: GeoIpCredentials;
  fetchImpl: (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  persistArchive: (archive: Buffer) => Promise<string>;
}

export type RefreshGeoLite2Result =
  | { status: 'skipped_no_key' }
  | { status: 'download_failed'; httpStatus: number }
  | { status: 'ok'; dbPath: string };

export async function refreshGeoLite2Db(
  options: RefreshGeoLite2Options,
): Promise<RefreshGeoLite2Result> {
  const { licenseKey } = options.credentials;
  if (!licenseKey) return { status: 'skipped_no_key' };

  const response = await options.fetchImpl(buildGeoLite2DownloadUrl(licenseKey));
  if (!response.ok) return { status: 'download_failed', httpStatus: response.status };

  const archive = Buffer.from(await response.arrayBuffer());
  const dbPath = await options.persistArchive(archive);
  return { status: 'ok', dbPath };
}
