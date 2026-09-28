import { ALLOWED_CONFIG_FILES } from '@squad/shared-config';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import installProgressPlugin, {
  INSTALL_PROGRESS_RETENTION_MS,
  type ProgressLine,
} from '../src/plugins/install-progress.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

// The sidecar relaunch writes real files under /run; keep install tests off
// the host's runtime dir (see server-install-configs.test.ts).
vi.mock('../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/rnsquadjs.js')>()),
  writeSidecarConfig: vi.fn().mockResolvedValue(undefined),
  relaunchSidecar: vi.fn().mockResolvedValue({ containerId: 'rnsquadjs-xyz', mode: 'shadow' }),
}));

const SERVER = '0190a000-0000-7000-8000-00000000aa01';

function line(step: string, message = step): ProgressLine {
  return { ts: new Date().toISOString(), step, message };
}

async function buildBus() {
  const app = Fastify({ logger: false });
  await app.register(installProgressPlugin);
  await app.ready();
  return app;
}

describe('install-progress bus (#72)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reset() drops the buffered lines of a server', async () => {
    const app = await buildBus();
    app.installProgress.publish(SERVER, line('depot'));
    app.installProgress.publish(SERVER, line('error', 'previous attempt failed'));

    app.installProgress.reset(SERVER);

    expect(app.installProgress.snapshot(SERVER)).toEqual([]);
    await app.close();
  });

  it('evicts a finished install buffer after the retention window', async () => {
    vi.useFakeTimers();
    const app = await buildBus();
    app.installProgress.publish(SERVER, line('depot'));
    app.installProgress.publish(SERVER, line('done'));
    expect(app.installProgress.snapshot(SERVER)).toHaveLength(2);

    vi.advanceTimersByTime(INSTALL_PROGRESS_RETENTION_MS + 1);

    expect(app.installProgress.snapshot(SERVER)).toEqual([]);
    await app.close();
  });

  it('keeps a new attempt started after a final line from being evicted with it', async () => {
    vi.useFakeTimers();
    const app = await buildBus();
    app.installProgress.publish(SERVER, line('error'));
    app.installProgress.reset(SERVER);
    app.installProgress.publish(SERVER, line('depot', 'second attempt'));

    vi.advanceTimersByTime(INSTALL_PROGRESS_RETENTION_MS + 1);

    expect(app.installProgress.snapshot(SERVER).map((l) => l.message)).toEqual(['second attempt']);
    await app.close();
  });
});

describe('install/delete routes reset the progress buffer (#72)', () => {
  let h: IntegrationHarness;

  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: testSteamId(72001) } });
  });
  afterAll(async () => {
    await h?.cleanup();
  });

  async function createServer(cookie: string, base: number): Promise<string> {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        display_name: `Progress reset ${base}`,
        slug: `progress-reset-${base}`,
        description: 'install-progress reset fixture',
        game_port: base,
        query_port: base + 20_000,
        beacon_port: base + 8_000,
        rcon_port: base + 14_000,
        max_players: 80,
        tickrate: 50,
        multihome: '0.0.0.0',
        extra_args: '',
      },
    });
    if (resp.statusCode !== 201) throw new Error(`create failed: ${resp.body}`);
    return resp.json<{ id: string }>().id;
  }

  it('a new install does not replay the previous attempt’s lines', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createServer(cookie, 7900);
    h.app.installProgress.publish(id, line('error', 'stale failure from the last attempt'));

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/install`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);

    const messages = h.app.installProgress.snapshot(id).map((l) => l.message);
    expect(messages).not.toContain('stale failure from the last attempt');
  });

  it('deleting a server frees its buffered install lines', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createServer(cookie, 7920);
    for (const file of ALLOWED_CONFIG_FILES) {
      h.bridge.files.set(
        `/var/lib/squad-panel/configs/${id}/ServerConfig/${file}`,
        Buffer.from('key=v\n', 'utf-8'),
      );
    }
    h.app.installProgress.publish(id, line('done', 'install complete'));

    const resp = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(resp.statusCode, resp.body).toBe(200);

    expect(h.app.installProgress.snapshot(id)).toEqual([]);
  });
});
