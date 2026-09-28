import { describe, expect, it } from 'vitest';
import { serverPatch, serverSettingsUpdate } from '../src/server-settings.js';

describe('serverSettingsUpdate port uniqueness', () => {
  it('accepts distinct optional ports', () => {
    expect(
      serverSettingsUpdate.safeParse({
        game_port: 7787,
        query_port: 27_165,
        beacon_port: 15_000,
        rcon_port: 21_114,
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate ports', () => {
    const result = serverSettingsUpdate.safeParse({ game_port: 7787, rcon_port: 7787 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ message: 'Ports must be unique' }),
      );
    }
  });
});

describe('serverSettingsUpdate launch/resource knobs (#53)', () => {
  // #1186: none of these ever reached `docker run`, so accepting them told the
  // operator a limit was in force when the container ran unlimited.
  it.each([
    ['extra_args', '-log'],
    ['cpu_affinity', '0-3'],
    ['cpu_weight', 100],
    ['niceness', 5],
    ['memory_high_mb', 4096],
    ['memory_max_mb', 8192],
    ['io_weight', 100],
  ])('rejects the never-applied knob %s', (key, value) => {
    expect(serverSettingsUpdate.safeParse({ [key]: value }).success).toBe(false);
  });

  it('still accepts the unset value of each knob', () => {
    expect(
      serverSettingsUpdate.safeParse({
        extra_args: '',
        cpu_affinity: null,
        cpu_weight: null,
        niceness: null,
        memory_high_mb: null,
        memory_max_mb: null,
        io_weight: null,
      }).success,
    ).toBe(true);
  });
});

describe('serverSettingsUpdate multihome (#53 #1187)', () => {
  it('accepts IPv4, IPv6 and null', () => {
    expect(serverSettingsUpdate.safeParse({ multihome: '192.168.1.10' }).success).toBe(true);
    expect(serverSettingsUpdate.safeParse({ multihome: '2001:db8::1' }).success).toBe(true);
    expect(serverSettingsUpdate.safeParse({ multihome: null }).success).toBe(true);
  });

  it.each(['0.0.0.0 -ExecCmds=quit', '0.0.0.0"', 'localhost', ''])(
    'rejects the non-IP value %j',
    (multihome) => {
      expect(serverSettingsUpdate.safeParse({ multihome }).success).toBe(false);
    },
  );
});

describe('serverPatch license pairing (SRV-6 #45)', () => {
  const incompleteMessages = (input: unknown): string[] => {
    const result = serverPatch.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it('accepts a full id+key pair', () => {
    expect(serverPatch.safeParse({ license_id: 'lic-1', license_key: 'k-secret' }).success).toBe(
      true,
    );
  });

  it('accepts a paired detach (both null) and a key-only detach', () => {
    expect(serverPatch.safeParse({ license_id: null, license_key: null }).success).toBe(true);
    expect(serverPatch.safeParse({ license_key: null }).success).toBe(true);
  });

  it('accepts an id-only edit (stored key untouched)', () => {
    expect(serverPatch.safeParse({ license_id: 'lic-2' }).success).toBe(true);
  });

  it('rejects a key without an id as license_incomplete', () => {
    expect(incompleteMessages({ license_key: 'k-secret' })).toContain('license_incomplete');
    expect(incompleteMessages({ license_id: null, license_key: 'k-secret' })).toContain(
      'license_incomplete',
    );
  });

  it('rejects clearing exactly one side as license_incomplete', () => {
    expect(incompleteMessages({ license_id: 'lic-1', license_key: null })).toContain(
      'license_incomplete',
    );
    expect(incompleteMessages({ license_id: null })).toContain('license_incomplete');
  });

  it('trims and rejects blank license values', () => {
    const parsed = serverPatch.safeParse({ license_id: '  lic-1  ', license_key: '  k  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.license_id).toBe('lic-1');
      expect(parsed.data.license_key).toBe('k');
    }
    expect(serverPatch.safeParse({ license_id: '   ', license_key: 'k' }).success).toBe(false);
  });
});
