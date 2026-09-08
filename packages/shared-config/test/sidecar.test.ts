import { describe, expect, it } from 'vitest';
import {
  legacySidecarStatusKey,
  resolveSidecarEngine,
  SQUADJS2_ENGINE_SET,
  sidecarConfigDir,
  sidecarContainerName,
  sidecarHeartbeatKey,
  sidecarStatusKey,
} from '../src/sidecar.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';

describe('sidecar redis keys', () => {
  it('names the engine set', () => {
    expect(SQUADJS2_ENGINE_SET).toBe('squadjs2:engine-servers');
  });

  it('builds engine-neutral status keys per mode', () => {
    expect(sidecarStatusKey(SERVER_ID, 'production')).toBe(`sidecar:status:${SERVER_ID}`);
    expect(sidecarStatusKey(SERVER_ID, 'shadow')).toBe(`sidecar:status:${SERVER_ID}:shadow`);
  });

  it('keeps the legacy RNSquadJS status keys readable for the migration fallback', () => {
    expect(legacySidecarStatusKey(SERVER_ID, 'production')).toBe(`rnsquadjs:status:${SERVER_ID}`);
    expect(legacySidecarStatusKey(SERVER_ID, 'shadow')).toBe(
      `rnsquadjs:status:${SERVER_ID}:shadow`,
    );
  });

  it('never collides with the worker-rcon status key (D4)', () => {
    expect(sidecarStatusKey(SERVER_ID, 'production')).not.toBe(`rcon:status:${SERVER_ID}`);
  });

  it('builds the heartbeat key the panel health view reads', () => {
    expect(sidecarHeartbeatKey(SERVER_ID)).toBe(`worker:heartbeat:sidecar:${SERVER_ID}`);
  });

  it('builds per-engine container names and config dirs', () => {
    expect(sidecarContainerName('squadjs2', SERVER_ID)).toBe(`squadjs2-${SERVER_ID}`);
    expect(sidecarContainerName('rnsquadjs', SERVER_ID)).toBe(`rnsquadjs-${SERVER_ID}`);
    expect(sidecarConfigDir('squadjs2', SERVER_ID)).toBe(`/run/squad-panel/squadjs2/${SERVER_ID}`);
    expect(sidecarConfigDir('rnsquadjs', SERVER_ID)).toBe(
      `/run/squad-panel/rnsquadjs/${SERVER_ID}`,
    );
  });
});

describe('resolveSidecarEngine', () => {
  it('returns squadjs2 for members of the engine set', async () => {
    const redis = { sismember: async () => 1 };
    await expect(resolveSidecarEngine(redis, SERVER_ID)).resolves.toBe('squadjs2');
  });

  it('defaults to rnsquadjs for non-members', async () => {
    const redis = { sismember: async () => 0 };
    await expect(resolveSidecarEngine(redis, SERVER_ID)).resolves.toBe('rnsquadjs');
  });

  it('queries exactly the engine set', async () => {
    const calls: string[][] = [];
    const redis = {
      sismember: async (key: string, member: string) => {
        calls.push([key, member]);
        return 0;
      },
    };
    await resolveSidecarEngine(redis, SERVER_ID);
    expect(calls).toEqual([[SQUADJS2_ENGINE_SET, SERVER_ID]]);
  });
});
