import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER = 76561198000000001n;

async function seedRunning(h: IntegrationHarness) {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Server ${id.slice(0, 4)}`,
    slug: `s-${id}`,
    status: 'running',
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

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER } });
  await h.redis.del('depot:updating', 'depot:build_id', 'depot:last_update');
});

afterEach(async () => {
  await h.redis.del('depot:updating', 'depot:build_id', 'depot:last_update');
  await h.cleanup();
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
    h.bridge.containerStart = async ({ name }) => {
      startedNames.push(name);
      return { status: 'ok' };
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

    // Wait for background task to complete
    await new Promise((r) => setTimeout(r, 200));

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
  });

  it('restarts servers even when depot update fails', async () => {
    const id = await seedRunning(h);
    const cookie = await loginAsOwner(h);

    const startedNames: string[] = [];
    h.bridge.containerStart = async ({ name }) => {
      startedNames.push(name);
      return { status: 'ok' };
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

    await new Promise((r) => setTimeout(r, 200));

    // Server should still be restarted even though depot update failed
    expect(startedNames).toContain(`squad-${id}`);

    // Check last_update shows failure
    const lastUpdate = JSON.parse((await h.redis.get('depot:last_update')) ?? '{}');
    expect(lastUpdate.status).toBe('failed');
  });
});
