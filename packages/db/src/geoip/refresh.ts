export const GEOLITE2_CITY_EDITION = 'GeoLite2-City';
export const GEOIP_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Network defaults for the download below; overridable per call for tests. */
export const GEOIP_DOWNLOAD_TIMEOUT_MS = 30_000;
/** The GeoLite2-City tar.gz is normally well under 100 MB; this is a generous cap against a runaway/hostile response. */
export const GEOIP_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/**
 * Builds the MaxMind GeoIP database-download URL for the current
 * (`/geoip/databases/{edition}/download`) API. Credentials are sent as an
 * HTTP `Authorization: Basic` header ({@link buildGeoLite2BasicAuthHeader}),
 * never in the URL — the legacy `app/geoip_download?license_key=...` endpoint
 * put the license key in the query string, where it ends up in access logs,
 * proxies and browser/request-library history.
 */
export function buildGeoLite2DownloadUrl(): string {
  const params = new URLSearchParams({ suffix: 'tar.gz' });
  return `https://download.maxmind.com/geoip/databases/${GEOLITE2_CITY_EDITION}/download?${params.toString()}`;
}

/** `Authorization` header value for MaxMind's HTTP Basic Auth (account id + license key). */
export function buildGeoLite2BasicAuthHeader(accountId: string, licenseKey: string): string {
  return `Basic ${Buffer.from(`${accountId}:${licenseKey}`).toString('base64')}`;
}

export function shouldRefreshGeoIpDb(lastRefreshedAt: Date | null, now: Date): boolean {
  if (!lastRefreshedAt) return true;
  return now.getTime() - lastRefreshedAt.getTime() >= GEOIP_REFRESH_INTERVAL_MS;
}

export interface GeoIpCredentials {
  accountId: string | null;
  licenseKey: string | null;
}

export interface GeoIpFetchResponse {
  ok: boolean;
  status: number;
  /** Optional so lightweight test doubles need not implement the full Headers API. */
  headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RefreshGeoLite2Options {
  credentials: GeoIpCredentials;
  fetchImpl: (
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<GeoIpFetchResponse>;
  persistArchive: (archive: Buffer) => Promise<string>;
  /** @default GEOIP_DOWNLOAD_TIMEOUT_MS */
  timeoutMs?: number;
  /** @default GEOIP_MAX_ARCHIVE_BYTES */
  maxArchiveBytes?: number;
}

export type RefreshGeoLite2Result =
  | { status: 'skipped_no_key' }
  | { status: 'download_failed'; httpStatus: number }
  | { status: 'archive_too_large'; contentLength: number }
  | { status: 'ok'; dbPath: string };

/**
 * Downloads the current GeoLite2-City database from MaxMind and hands the
 * archive to {@link RefreshGeoLite2Options.persistArchive}.
 *
 * Both {@link GeoIpCredentials} fields are required: MaxMind's current API
 * authenticates with the account id and license key together (HTTP Basic
 * Auth), so a license key without an account id can no longer authenticate
 * and is treated the same as having no credentials at all.
 *
 * The request is bounded on both ends against a slow or hostile server: it
 * aborts after {@link RefreshGeoLite2Options.timeoutMs}, and the response is
 * rejected — before buffering the body — once a `Content-Length` reports
 * more than {@link RefreshGeoLite2Options.maxArchiveBytes}; the buffered size
 * is checked again afterwards in case no `Content-Length` was sent.
 */
export async function refreshGeoLite2Db(
  options: RefreshGeoLite2Options,
): Promise<RefreshGeoLite2Result> {
  const { accountId, licenseKey } = options.credentials;
  if (!accountId || !licenseKey) return { status: 'skipped_no_key' };

  const maxArchiveBytes = options.maxArchiveBytes ?? GEOIP_MAX_ARCHIVE_BYTES;

  const response = await options.fetchImpl(buildGeoLite2DownloadUrl(), {
    headers: { Authorization: buildGeoLite2BasicAuthHeader(accountId, licenseKey) },
    signal: AbortSignal.timeout(options.timeoutMs ?? GEOIP_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) return { status: 'download_failed', httpStatus: response.status };

  const declaredLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxArchiveBytes) {
    return { status: 'archive_too_large', contentLength: declaredLength };
  }

  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.byteLength > maxArchiveBytes) {
    return { status: 'archive_too_large', contentLength: archive.byteLength };
  }

  const dbPath = await options.persistArchive(archive);
  return { status: 'ok', dbPath };
}
