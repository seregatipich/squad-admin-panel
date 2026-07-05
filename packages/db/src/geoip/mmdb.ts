import { access } from 'node:fs/promises';
import type { GeoFields, GeoLookup } from './resolver.js';
import { mapMaxmindCity } from './resolver.js';

interface MmdbReader {
  get(ip: string): unknown;
}

interface MaxmindModule {
  open(dbPath: string): Promise<MmdbReader>;
}

async function loadMaxmindModule(): Promise<MaxmindModule | null> {
  const moduleName = 'maxmind';
  try {
    return (await import(moduleName)) as unknown as MaxmindModule;
  } catch {
    return null;
  }
}

export async function createMmdbLookup(
  dbPath: string | null | undefined,
): Promise<GeoLookup | null> {
  if (!dbPath) return null;
  try {
    await access(dbPath);
  } catch {
    return null;
  }
  const maxmind = await loadMaxmindModule();
  if (!maxmind) return null;
  let reader: MmdbReader;
  try {
    reader = await maxmind.open(dbPath);
  } catch {
    return null;
  }
  return {
    lookup(ip: string): GeoFields | null {
      const response = reader.get(ip);
      if (!response || typeof response !== 'object') return null;
      return mapMaxmindCity(response as Parameters<typeof mapMaxmindCity>[0]);
    },
  };
}
