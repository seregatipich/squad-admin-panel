export const DEFAULT_COUNTRY_SWITCH_WINDOW_HOURS = 24;
export const DEFAULT_MULTI_COUNTRY_THRESHOLD = 3;

const HOUR_MS = 3_600_000;

export interface GeoObservation {
  countryCode: string | null;
  countryName: string | null;
  observedAt: Date;
}

export interface GeoAnomalyConfig {
  switchWindowHours: number;
  multiCountryThreshold: number;
}

export interface CountrySwitch {
  fromCountryCode: string;
  fromCountryName: string | null;
  toCountryCode: string;
  toCountryName: string | null;
  fromObservedAt: Date;
  toObservedAt: Date;
  gapHours: number;
  withinWindow: boolean;
}

export interface DistinctCountry {
  countryCode: string;
  countryName: string | null;
  firstObservedAt: Date;
  lastObservedAt: Date;
  observationCount: number;
}

export interface GeoAnomalyResult {
  switches: CountrySwitch[];
  distinctCountries: DistinctCountry[];
  distinctCountryCount: number;
  multiCountry: boolean;
  hasRecentSwitch: boolean;
}

function resolveConfig(config: Partial<GeoAnomalyConfig> | undefined): GeoAnomalyConfig {
  const switchWindowHours =
    config?.switchWindowHours != null && config.switchWindowHours > 0
      ? config.switchWindowHours
      : DEFAULT_COUNTRY_SWITCH_WINDOW_HOURS;
  const multiCountryThreshold =
    config?.multiCountryThreshold != null && config.multiCountryThreshold >= 0
      ? config.multiCountryThreshold
      : DEFAULT_MULTI_COUNTRY_THRESHOLD;
  return { switchWindowHours, multiCountryThreshold };
}

export function detectGeoAnomalies(
  observations: readonly GeoObservation[],
  config?: Partial<GeoAnomalyConfig>,
): GeoAnomalyResult {
  const { switchWindowHours, multiCountryThreshold } = resolveConfig(config);

  const known = observations
    .filter((obs) => typeof obs.countryCode === 'string' && obs.countryCode.length > 0)
    .map((obs) => ({
      countryCode: obs.countryCode as string,
      countryName: obs.countryName,
      observedAt: obs.observedAt,
    }))
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  const distinctMap = new Map<string, DistinctCountry>();
  const switches: CountrySwitch[] = [];
  let previous: (typeof known)[number] | null = null;

  for (const current of known) {
    const existing = distinctMap.get(current.countryCode);
    if (existing) {
      existing.lastObservedAt = current.observedAt;
      existing.observationCount += 1;
      if (current.countryName && !existing.countryName) {
        existing.countryName = current.countryName;
      }
    } else {
      distinctMap.set(current.countryCode, {
        countryCode: current.countryCode,
        countryName: current.countryName,
        firstObservedAt: current.observedAt,
        lastObservedAt: current.observedAt,
        observationCount: 1,
      });
    }

    if (previous && previous.countryCode !== current.countryCode) {
      const gapHours = (current.observedAt.getTime() - previous.observedAt.getTime()) / HOUR_MS;
      switches.push({
        fromCountryCode: previous.countryCode,
        fromCountryName: previous.countryName,
        toCountryCode: current.countryCode,
        toCountryName: current.countryName,
        fromObservedAt: previous.observedAt,
        toObservedAt: current.observedAt,
        gapHours,
        withinWindow: gapHours < switchWindowHours,
      });
    }
    previous = current;
  }

  const distinctCountries = [...distinctMap.values()].sort(
    (a, b) => b.lastObservedAt.getTime() - a.lastObservedAt.getTime(),
  );

  return {
    switches,
    distinctCountries,
    distinctCountryCount: distinctCountries.length,
    multiCountry: distinctCountries.length > multiCountryThreshold,
    hasRecentSwitch: switches.some((entry) => entry.withinWindow),
  };
}
