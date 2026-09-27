import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

// Unique steam id (test range) so this file never collides with the other
// settings integration suites that share the parallel test:cov database.
const OWNER_STEAM_ID = 76561198222075151n;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterAll(async () => {
  await h.cleanup();
});

/** Inserts a server + settings + credentials row and returns the server id. */
async function seedServer(slug: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Test ${slug}`,
    slug,
    status: 'stopped',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
    maxPlayers: 80,
    tickrate: 50,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.alloc(64, 0x01),
  });
  return id;
}

describeIfDb('LOG-3 archive-to-backup settings', () => {
  it('defaults archive_logs_to_backup to false and exposes it on GET', async () => {
    const serverId = await seedServer('log3-default');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { settings: { archive_logs_to_backup: boolean } };
    expect(body.settings.archive_logs_to_backup).toBe(false);

    const row = await h.db.query.serverSettings.findFirst({
      where: eq(serverSettings.serverId, serverId),
    });
    expect(row?.archiveLogsToBackup).toBe(false);
  });

  it('PUT settings persists archive_logs_to_backup and returns it', async () => {
    const serverId = await seedServer('log3-enable');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { archive_logs_to_backup: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { archive_logs_to_backup: boolean };
    expect(body.archive_logs_to_backup).toBe(true);

    const row = await h.db.query.serverSettings.findFirst({
      where: eq(serverSettings.serverId, serverId),
    });
    expect(row?.archiveLogsToBackup).toBe(true);
  });

  it('PUT settings can disable archive_logs_to_backup again', async () => {
    const serverId = await seedServer('log3-toggle');
    const cookie = await loginAsOwner(h);

    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { archive_logs_to_backup: true },
    });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { archive_logs_to_backup: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { archive_logs_to_backup: boolean };
    expect(body.archive_logs_to_backup).toBe(false);

    const row = await h.db.query.serverSettings.findFirst({
      where: eq(serverSettings.serverId, serverId),
    });
    expect(row?.archiveLogsToBackup).toBe(false);
  });

  it('rejects a non-boolean archive_logs_to_backup → 400', async () => {
    const serverId = await seedServer('log3-bad');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { archive_logs_to_backup: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});
