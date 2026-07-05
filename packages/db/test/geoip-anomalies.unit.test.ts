import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COUNTRY_SWITCH_WINDOW_HOURS,
  DEFAULT_MULTI_COUNTRY_THRESHOLD,
  detectGeoAnomalies,
  type GeoObservation,
} from '../src/geoip/anomalies.js';

const HOUR_MS = 3_600_000;
const ANCHOR = Date.parse('2026-07-01T00:00:00.000Z');

function obs(
  countryCode: string | null,
  hoursFromAnchor: number,
  countryName?: string,
): GeoObservation {
  return {
    countryCode,
    countryName: countryName ?? (countryCode ? `${countryCode} land` : null),
    observedAt: new Date(ANCHOR + hoursFromAnchor * HOUR_MS),
  };
}

describe('detectGeoAnomalies exports sane defaults', () => {
  it('keeps the documented defaults', () => {
    expect(DEFAULT_COUNTRY_SWITCH_WINDOW_HOURS).toBe(24);
    expect(DEFAULT_MULTI_COUNTRY_THRESHOLD).toBe(3);
  });
});

describe('country-switch detection', () => {
  it('reports no switch when every observation is the same country', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs('DE', 5), obs('DE', 40)]);
    expect(result.switches).toHaveLength(0);
    expect(result.hasRecentSwitch).toBe(false);
    expect(result.distinctCountryCount).toBe(1);
  });

  it('flags a country change inside the default 24h window as a recent switch', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs('RU', 6)]);
    expect(result.switches).toHaveLength(1);
    const [entry] = result.switches;
    expect(entry.fromCountryCode).toBe('DE');
    expect(entry.toCountryCode).toBe('RU');
    expect(entry.gapHours).toBeCloseTo(6);
    expect(entry.withinWindow).toBe(true);
    expect(result.hasRecentSwitch).toBe(true);
  });

  it('does not treat a switch after 48h as recent under the default window', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs('RU', 48)]);
    expect(result.switches).toHaveLength(1);
    expect(result.switches[0].withinWindow).toBe(false);
    expect(result.hasRecentSwitch).toBe(false);
  });

  it('treats the exact window boundary as outside the window', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs('RU', 24)]);
    expect(result.switches[0].withinWindow).toBe(false);
    expect(result.hasRecentSwitch).toBe(false);
  });

  it('honours a configurable window so a 48h switch can still alert', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs('RU', 48)], { switchWindowHours: 72 });
    expect(result.switches[0].withinWindow).toBe(true);
    expect(result.hasRecentSwitch).toBe(true);
  });

  it('orders unsorted observations chronologically before comparing', () => {
    const result = detectGeoAnomalies([obs('RU', 6), obs('DE', 0)]);
    expect(result.switches).toHaveLength(1);
    expect(result.switches[0].fromCountryCode).toBe('DE');
    expect(result.switches[0].toCountryCode).toBe('RU');
  });

  it('ignores observations without a known country when detecting switches', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs(null, 3), obs('RU', 6)]);
    expect(result.switches).toHaveLength(1);
    expect(result.switches[0].fromCountryCode).toBe('DE');
    expect(result.switches[0].toCountryCode).toBe('RU');
    expect(result.distinctCountryCount).toBe(2);
  });

  it('emits one switch per consecutive distinct-country transition', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs('RU', 6), obs('DE', 10)]);
    expect(result.switches).toHaveLength(2);
    expect(result.switches.map((entry) => entry.toCountryCode)).toEqual(['RU', 'DE']);
  });
});

describe('multi-country soft flag threshold', () => {
  it('does not flag when distinct countries equal the threshold', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs('RU', 1), obs('US', 2)]);
    expect(result.distinctCountryCount).toBe(3);
    expect(result.multiCountry).toBe(false);
  });

  it('flags when distinct countries exceed the threshold', () => {
    const result = detectGeoAnomalies([obs('DE', 0), obs('RU', 1), obs('US', 2), obs('FR', 3)]);
    expect(result.distinctCountryCount).toBe(4);
    expect(result.multiCountry).toBe(true);
  });

  it('respects a lowered configurable threshold at the boundary', () => {
    const observations = [obs('DE', 0), obs('RU', 1)];
    expect(detectGeoAnomalies(observations, { multiCountryThreshold: 2 }).multiCountry).toBe(false);
    expect(detectGeoAnomalies(observations, { multiCountryThreshold: 1 }).multiCountry).toBe(true);
  });

  it('falls back to defaults for non-positive or invalid config values', () => {
    const observations = [obs('DE', 0), obs('RU', 6), obs('US', 12), obs('FR', 18)];
    const result = detectGeoAnomalies(observations, {
      switchWindowHours: 0,
      multiCountryThreshold: -5,
    });
    expect(result.switches[0].withinWindow).toBe(true);
    expect(result.multiCountry).toBe(true);
  });

  it('aggregates distinct-country metadata across repeated visits', () => {
    const result = detectGeoAnomalies([
      obs('DE', 0, 'Germany'),
      obs('DE', 5),
      obs('RU', 10, 'Russia'),
    ]);
    const germany = result.distinctCountries.find((entry) => entry.countryCode === 'DE');
    expect(germany?.observationCount).toBe(2);
    expect(germany?.countryName).toBe('Germany');
    expect(result.distinctCountries[0].countryCode).toBe('RU');
  });

  it('returns an empty result for no observations', () => {
    const result = detectGeoAnomalies([]);
    expect(result.switches).toHaveLength(0);
    expect(result.distinctCountries).toHaveLength(0);
    expect(result.multiCountry).toBe(false);
    expect(result.hasRecentSwitch).toBe(false);
  });
});
