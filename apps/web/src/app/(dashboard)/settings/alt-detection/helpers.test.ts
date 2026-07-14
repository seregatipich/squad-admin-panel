import { describe, expect, it } from 'vitest';
import { formatCidr, isValidIpOrCidr, validateAltDetectionSettingsForm } from './helpers';

describe('isValidIpOrCidr', () => {
  it('accepts a bare IPv4 address', () => {
    expect(isValidIpOrCidr('10.0.0.5')).toBe(true);
  });

  it('accepts an IPv4 CIDR block with all-zero host bits', () => {
    expect(isValidIpOrCidr('192.168.0.0/16')).toBe(true);
    expect(isValidIpOrCidr('10.0.0.0/8')).toBe(true);
  });

  it('rejects an IPv4 CIDR with nonzero host bits', () => {
    expect(isValidIpOrCidr('10.0.0.1/8')).toBe(false);
  });

  it('accepts a bare IPv6 address and an IPv6 CIDR block', () => {
    expect(isValidIpOrCidr('::1')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true);
  });

  it('rejects an IPv6 CIDR with nonzero host bits', () => {
    expect(isValidIpOrCidr('2001:db8::1/32')).toBe(false);
  });

  it('rejects junk input', () => {
    expect(isValidIpOrCidr('999.1.2.3')).toBe(false);
    expect(isValidIpOrCidr('abc')).toBe(false);
    expect(isValidIpOrCidr('')).toBe(false);
  });

  it('rejects an out-of-range prefix', () => {
    expect(isValidIpOrCidr('10.0.0.0/33')).toBe(false);
    expect(isValidIpOrCidr('2001:db8::/129')).toBe(false);
  });
});

describe('formatCidr', () => {
  it('trims whitespace and lowercases the value', () => {
    expect(formatCidr('  2001:DB8::/32  ')).toBe('2001:db8::/32');
  });
});

describe('validateAltDetectionSettingsForm', () => {
  const baseForm = {
    weight_shared_ip: 50,
    weight_shared_name: 25,
    weight_young_account: 15,
    weight_steamid_proximity: 10,
    steamid_delta_threshold: 10_000,
    medium_threshold: 50,
    high_threshold: 75,
  };

  it('accepts a valid form', () => {
    expect(validateAltDetectionSettingsForm(baseForm)).toBeNull();
  });

  it('rejects medium_threshold above high_threshold', () => {
    expect(
      validateAltDetectionSettingsForm({ ...baseForm, medium_threshold: 90, high_threshold: 80 }),
    ).not.toBeNull();
  });

  it('accepts medium_threshold exactly equal to high_threshold', () => {
    expect(
      validateAltDetectionSettingsForm({ ...baseForm, medium_threshold: 75, high_threshold: 75 }),
    ).toBeNull();
  });

  it('rejects a negative weight', () => {
    expect(validateAltDetectionSettingsForm({ ...baseForm, weight_shared_ip: -1 })).not.toBeNull();
  });

  it('rejects a non-integer value', () => {
    expect(validateAltDetectionSettingsForm({ ...baseForm, weight_shared_ip: 1.5 })).not.toBeNull();
  });
});
