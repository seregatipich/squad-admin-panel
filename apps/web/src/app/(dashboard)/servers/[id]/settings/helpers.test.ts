import { describe, expect, it } from 'vitest';
import {
  licenseRestartRequired,
  sidecarEngineLabel,
  sidecarModeLabel,
  sidecarStatusPill,
} from './helpers';

describe('licenseRestartRequired (SRV-6 #45)', () => {
  it('is false when no license change is on record', () => {
    expect(licenseRestartRequired(null, true, '2026-07-01T10:00:00.000Z')).toBe(false);
    expect(licenseRestartRequired(null, false, null)).toBe(false);
  });

  it('is true when the license changed after the container started', () => {
    expect(
      licenseRestartRequired('2026-07-01T12:00:00.000Z', true, '2026-07-01T10:00:00.000Z'),
    ).toBe(true);
  });

  it('is true when a license is recorded but the container is not running', () => {
    expect(licenseRestartRequired('2026-07-01T12:00:00.000Z', false, null)).toBe(true);
    expect(licenseRestartRequired('2026-07-01T12:00:00.000Z', true, null)).toBe(true);
  });

  it('is false when the container started after the license change', () => {
    expect(
      licenseRestartRequired('2026-07-01T12:00:00.000Z', true, '2026-07-01T13:00:00.000Z'),
    ).toBe(false);
  });
});

describe('sidecarModeLabel (STATS-4 #71)', () => {
  it('names each of the three sidecar modes distinctly', () => {
    const titles = (['production', 'shadow', 'legacy'] as const).map(
      (m) => sidecarModeLabel(m).title,
    );
    expect(titles).toEqual(['Продакшен', 'Теневой режим', 'Штатный парсер']);
    expect(new Set(titles).size).toBe(3);
  });

  it('gives every mode a non-empty explanation', () => {
    for (const mode of ['production', 'shadow', 'legacy'] as const) {
      expect(sidecarModeLabel(mode).hint.length).toBeGreaterThan(0);
    }
  });
});

describe('sidecarStatusPill (STATS-4 #71)', () => {
  it('reads a missing heartbeat as "no signal", not as an error', () => {
    expect(sidecarStatusPill(null)).toEqual({ text: 'Нет сигнала', tone: 'neutral' });
  });

  it('maps a connected heartbeat to the green tone', () => {
    expect(
      sidecarStatusPill({ state: 'connected', last_change: '2026-07-27T10:00:00.000Z' }),
    ).toEqual({ text: 'RCON подключён', tone: 'green' });
  });

  it('maps a disconnected heartbeat to the amber tone', () => {
    expect(
      sidecarStatusPill({ state: 'disconnected', last_change: '2026-07-27T10:00:00.000Z' }),
    ).toEqual({ text: 'RCON отключён', tone: 'amber' });
  });
});

describe('sidecarEngineLabel', () => {
  it('names the engine that is actually running', () => {
    expect(sidecarEngineLabel('squadjs2', 'production')).toBe('SquadJS2');
    expect(sidecarEngineLabel('rnsquadjs', 'shadow')).toBe('RNSquadJS (legacy)');
  });

  it('reports no sidecar in legacy mode regardless of the assigned engine', () => {
    expect(sidecarEngineLabel('squadjs2', 'legacy')).toBe('Не запущен');
    expect(sidecarEngineLabel('rnsquadjs', 'legacy')).toBe('Не запущен');
  });
});
