import { access } from 'node:fs/promises';
import { type CityResponse, open, type Reader } from 'maxmind';
import type { GeoFields, GeoLookup } from './resolver.js';
import { mapMaxmindCity } from './resolver.js';

/**
 * Opens a GeoLite2 City `.mmdb` file and wraps it as a {@link GeoLookup}.
 *
 * @param dbPath - Filesystem path of the database; `null`/`undefined` disables geo.
 * @returns The lookup, or `null` when no path is given, the file is missing or
 *   it is not a readable MaxMind database.
 */
export async function createMmdbLookup(
  dbPath: string | null | undefined,
): Promise<GeoLookup | null> {
  if (!dbPath) return null;
  try {
    await access(dbPath);
  } catch {
    return null;
  }
  let reader: Reader<CityResponse>;
  try {
    reader = await open<CityResponse>(dbPath);
  } catch {
    return null;
  }
  return {
    lookup(ip: string): GeoFields | null {
      const response = reader.get(ip);
      if (!response) return null;
      return mapMaxmindCity(response);
    },
  };
}
