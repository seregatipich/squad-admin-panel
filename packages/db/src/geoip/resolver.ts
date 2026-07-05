export interface GeoFields {
  countryCode: string | null;
  countryName: string | null;
  region: string | null;
  city: string | null;
  timezoneOffset: string | null;
  latitude: number | null;
  longitude: number | null;
}

export const NULL_GEO: Readonly<GeoFields> = Object.freeze({
  countryCode: null,
  countryName: null,
  region: null,
  city: null,
  timezoneOffset: null,
  latitude: null,
  longitude: null,
});

export interface GeoLookup {
  lookup(ip: string): GeoFields | null;
}

export function resolveGeo(lookup: GeoLookup | null | undefined, ip: string): GeoFields {
  if (!lookup) return { ...NULL_GEO };
  try {
    return lookup.lookup(ip) ?? { ...NULL_GEO };
  } catch {
    return { ...NULL_GEO };
  }
}

interface MaxmindCityResponse {
  country?: { iso_code?: string; names?: { en?: string } };
  subdivisions?: Array<{ names?: { en?: string } }>;
  city?: { names?: { en?: string } };
  location?: { time_zone?: string; latitude?: number; longitude?: number };
}

export function mapMaxmindCity(response: MaxmindCityResponse | null | undefined): GeoFields {
  if (!response) return { ...NULL_GEO };
  const subdivision = response.subdivisions?.[response.subdivisions.length - 1];
  return {
    countryCode: response.country?.iso_code ?? null,
    countryName: response.country?.names?.en ?? null,
    region: subdivision?.names?.en ?? null,
    city: response.city?.names?.en ?? null,
    timezoneOffset: response.location?.time_zone ?? null,
    latitude: typeof response.location?.latitude === 'number' ? response.location.latitude : null,
    longitude:
      typeof response.location?.longitude === 'number' ? response.location.longitude : null,
  };
}
