import { describe, expect, it } from 'vitest';
import { licenseRestartRequired } from './helpers';

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
