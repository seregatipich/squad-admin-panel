import { describe, expect, it } from 'vitest';
import { serverSettingsUpdate } from '../src/server-settings.js';

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
