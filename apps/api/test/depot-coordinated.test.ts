import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER = 76561198000000001n;

async function seedRunning(h: IntegrationHarness, status = 'running') {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Server ${id.slice(0, 4)}`,
    slug: `s-${id}`,
    status,
    runtime: 'container',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787 + Math.floor(Math.random() * 1000),
    queryPort: 27165 + Math.floor(Math.random() * 1000),
    beaconPort: 15000 + Math.floor(Math.random() * 1000),
    rconPort: 21114 + Math.floor(Math.random() * 1000),
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.from('test'),
    keyVersion: 1,
  });
  return id;
}

let h: IntegrationHarness;

async function waitForDepotUpdate(timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (await h.redis.exists('depot:updating')) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`depot update did not finish within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER } });
});

beforeEach(async () => {
  // Cases swap bridge methods and seed fake files on the shared app.
  Object.assign(h.bridge, makeFakeBridge());
  await h.redis.del('depot:updating', 'depot:build_id', 'depot:last_update', 'depot:progress');
  // Each case seeds its own 'running'/'starting' container server via
  // seedRunning(); left over from a previous case, one of these would count
  // as a live container server not listed in server_ids and now (#20
  // follow-up) trip the servers_running guard for every later case in this
  // file.
  await h.db.delete(servers);
});

afterEach(async () => {
  // A background update left running by a failed case would otherwise keep
  // writing depot:* keys into the next case.
  await waitForDepotUpdate();
  await h.redis.del('depot:updating', 'depot:build_id', 'depot:last_update', 'depot:progress');
});

afterAll(async () => {
  await h?.cleanup();
});

describe('POST /api/v1/depot/update with server_ids', () => {
  it('accepts server_ids and returns started status with servers_to_stop', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [id] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('started');
    expect(body.servers_to_stop).toEqual([id]);
    await waitForDepotUpdate();
  });

  it('works without server_ids (depot-only update)', async () => {
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('started');
    expect(body.servers_to_stop).toEqual([]);
    await waitForDepotUpdate();
  });

  it('rejects non-existent server IDs with 400', async () => {
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [uuidv7()] },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('servers_not_found');
    expect(body.missing).toHaveLength(1);
  });

  it('rejects mix of valid and non-existent server IDs', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);
    const bogus = uuidv7();

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [id, bogus] },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.missing).toEqual([bogus]);
  });
});

describe('GET /api/v1/depot', () => {
  it('includes build_id from Redis when set', async () => {
    await h.redis.set('depot:build_id', '12345678');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().build_id).toBe('12345678');
  });

  it('prefers Redis build_id over file-based one', async () => {
    // Seed the manifest file so the file-based parser would return '9999999'
    const { DEPOT_VOLUME_NAME } = await import('@squad/shared-config');
    const manifestPath = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/steamapps/appmanifest_403240.acf`;
    const markerPath = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/SquadGameServer.sh`;
    h.bridge.files.set(markerPath, Buffer.from('#!/bin/sh'));
    h.bridge.files.set(manifestPath, Buffer.from('"AppState"\n{\n  "buildid"\t\t"9999999"\n}\n'));

    // Set a different build ID in Redis
    await h.redis.set('depot:build_id', '1111111');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // Redis value wins over file-based value
    expect(res.json().build_id).toBe('1111111');
  });
});

describe('POST /api/v1/depot/update background orchestration', () => {
  it('stops servers, runs update, and restarts them', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);

    const stoppedNames: string[] = [];
    const startedNames: string[] = [];
    h.bridge.containerStop = async ({ name }) => {
      stoppedNames.push(name);
      return { status: 'ok' };
    };
    h.bridge.containerRun = async ({ server_id }) => {
      startedNames.push(`squad-${server_id}`);
      return { status: 'started', container_id: 'fresh' };
    };
    // Make fileRead return a valid manifest so build_id gets stored
    h.bridge.fileRead = async () => ({
      content: '"appid"\t\t"403240"\n"buildid"\t\t"99887766"',
    });

    await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [id] },
    });

    await waitForDepotUpdate();

    expect(stoppedNames).toContain(`squad-${id}`);
    expect(startedNames).toContain(`squad-${id}`);

    // Check DB status is 'starting' (stopped then restarted)
    const [row] = await h.db
      .select({ status: servers.status })
      .from(servers)
      .where(eq(servers.id, id));
    expect(row?.status).toBe('starting');

    // Check build_id was stored
    const buildId = await h.redis.get('depot:build_id');
    expect(buildId).toBe('99887766');

    // A done sentinel lands in depot:progress only after the restart phase
    // completes, so watchers don't see "done" while servers are still down.
    const streamEntries = (await h.redis.xrange('depot:progress', '-', '+')) as Array<
      [string, string[]]
    >;
    const lastFields = streamEntries.at(-1)?.[1] ?? [];
    const lastStream = lastFields[lastFields.indexOf('stream') + 1];
    const lastText = lastFields[lastFields.indexOf('text') + 1] ?? '{}';
    expect(lastStream).toBe('event');
    expect(JSON.parse(lastText)).toEqual({ done: true, final: 'done' });
  });

  it('restarts servers even when depot update fails', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);

    const startedNames: string[] = [];
    h.bridge.containerRun = async ({ server_id }) => {
      startedNames.push(`squad-${server_id}`);
      return { status: 'started', container_id: 'fresh' };
    };
    h.bridge.depotUpdate = async () => {
      throw new Error('steamcmd failed');
    };

    await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [id] },
    });

    await waitForDepotUpdate();

    // Server should still be restarted even though depot update failed
    expect(startedNames).toContain(`squad-${id}`);

    // Check last_update shows failure
    const lastUpdate = JSON.parse((await h.redis.get('depot:last_update')) ?? '{}');
    expect(lastUpdate.status).toBe('failed');

    const streamEntries = (await h.redis.xrange('depot:progress', '-', '+')) as Array<
      [string, string[]]
    >;
    const lastFields = streamEntries.at(-1)?.[1] ?? [];
    const lastStream = lastFields[lastFields.indexOf('stream') + 1];
    const lastText = lastFields[lastFields.indexOf('text') + 1] ?? '{}';
    expect(lastStream).toBe('event');
    expect(JSON.parse(lastText)).toEqual({ done: true, final: 'error', error: 'steamcmd failed' });
  });

  async function progressLines(stream: string): Promise<string[]> {
    const entries = (await h.redis.xrange('depot:progress', '-', '+')) as Array<[string, string[]]>;
    return entries
      .map(([, fields]) => fields)
      .filter((fields) => fields[fields.indexOf('stream') + 1] === stream)
      .map((fields) => fields[fields.indexOf('text') + 1] ?? '');
  }

  it('reports a server that failed to stop instead of swallowing the error (#143)', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);
    h.bridge.containerStop = async () => {
      throw new Error('container stop timed out');
    };

    await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [id] },
    });
    await waitForDepotUpdate();

    const stderr = await progressLines('stderr');
    expect(stderr.some((line) => line.includes(`squad-${id}`) && line.includes('timed out'))).toBe(
      true,
    );
    const [row] = await h.db
      .select({ status: servers.status })
      .from(servers)
      .where(eq(servers.id, id));
    expect(row?.status).toBe('running');
  });

  it('does not mark a server starting when it could not be restarted (#143)', async () => {
    const id = await seedRunning(h);
    await h.db.delete(serverSettings).where(eq(serverSettings.serverId, id));
    const cookie = await loginAsOwner(h);
    h.bridge.containerStart = async () => {
      throw new Error('no such container');
    };

    await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [id] },
    });
    await waitForDepotUpdate();

    const [row] = await h.db
      .select({ status: servers.status })
      .from(servers)
      .where(eq(servers.id, id));
    expect(row?.status).toBe('stopped');
    const stderr = await progressLines('stderr');
    expect(stderr.some((line) => line.includes(`squad-${id}`))).toBe(true);
  });
});

describe('POST /api/v1/depot/update restart uses current settings (#30 #320)', () => {
  it('recreates the container from server_settings instead of starting the old one', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);
    const calls: string[] = [];
    let ranGamePort: unknown;
    h.bridge.containerStop = async () => ({ status: 'ok' });
    h.bridge.containerStart = async ({ name }) => {
      calls.push(`start:${name}`);
      return { status: 'ok' };
    };
    h.bridge.containerRm = async ({ name }) => {
      calls.push(`rm:${name}`);
      return { status: 'ok' };
    };
    h.bridge.containerRun = async (params) => {
      calls.push(`run:${params.server_id}`);
      ranGamePort = params.game_port;
      return { status: 'started', container_id: 'fresh' };
    };

    await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [id] },
    });
    await waitForDepotUpdate();

    const [settings] = await h.db
      .select({ gamePort: serverSettings.gamePort })
      .from(serverSettings)
      .where(eq(serverSettings.serverId, id));
    expect(calls).toEqual([`rm:squad-${id}`, `run:${id}`]);
    expect(ranGamePort).toBe(settings?.gamePort);
  });
});

describe('POST /api/v1/depot/update with servers that are not running (#135)', () => {
  it('neither stops nor restarts a server the operator left stopped', async () => {
    const running = await seedRunning(h);
    const stopped = await seedRunning(h, 'stopped');
    const cookie = await loginAsOwner(h);

    const stoppedNames: string[] = [];
    const startedNames: string[] = [];
    h.bridge.containerStop = async ({ name }) => {
      stoppedNames.push(name);
      return { status: 'ok' };
    };
    h.bridge.containerRun = async ({ server_id }) => {
      startedNames.push(`squad-${server_id}`);
      return { status: 'started', container_id: 'fresh' };
    };

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: { server_ids: [running, stopped] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'started',
      servers_to_stop: [running],
      servers_skipped: [stopped],
    });

    await waitForDepotUpdate();

    expect(stoppedNames).toEqual([`squad-${running}`]);
    expect(startedNames).toEqual([`squad-${running}`]);
    const [row] = await h.db
      .select({ status: servers.status })
      .from(servers)
      .where(eq(servers.id, stopped));
    expect(row?.status).toBe('stopped');
  });
});

describe('POST /api/v1/depot/update lock ownership (#136)', () => {
  it('does not release a depot lock that another run took over', async () => {
    const cookie = await loginAsOwner(h);
    let finishUpdate: () => void = () => undefined;
    const updateRunning = new Promise<void>((started) => {
      h.bridge.depotUpdate = async () => {
        started();
        await new Promise<void>((resolve) => {
          finishUpdate = resolve;
        });
        return { exit_code: 0 };
      };
    });
    const runClosed = new Promise<void>((resolve) => {
      h.bridge.close = async () => resolve();
    });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: {},
    });
    expect(res.json().status).toBe('started');
    await updateRunning;

    // The first run's lock expired and a second run acquired the key.
    await h.redis.set('depot:updating', 'second-run', 'EX', 60);
    finishUpdate();
    await runClosed;

    expect(await h.redis.get('depot:updating')).toBe('second-run');
    await h.redis.del('depot:updating');
  });

  it('reports the start time of the run holding the lock', async () => {
    const cookie = await loginAsOwner(h);
    let finishUpdate: () => void = () => undefined;
    const updateRunning = new Promise<void>((started) => {
      h.bridge.depotUpdate = async () => {
        started();
        await new Promise<void>((resolve) => {
          finishUpdate = resolve;
        });
        return { exit_code: 0 };
      };
    });

    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: {},
    });
    await updateRunning;
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
      payload: {},
    });
    finishUpdate();

    expect(second.json()).toEqual({
      status: 'already_in_progress',
      since: first.json().started_at,
    });
  });
});
