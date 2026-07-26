// SRV-6 (#45): the stored license becomes real — PATCH /servers/:id writes
// License.cfg to disk (plaintext ONLY on disk), history and the config editor
// only ever see a masked copy, the server API exposes license *state* (never
// the key), and `restart_required` derives from container start time vs
// license_updated_at (License.cfg is requires_restart — no reload is fired).
import { configVersions, serverCredentials } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { rconCommandStream } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000045045n;
const LICENSE_ID = 'LIC-45-ID';
const LICENSE_KEY = 'SUPER-SECRET-LICENSE-KEY-45';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let cookie: string;
let serverId: string;
let licensePath: string;

describeIfDb('server license (SRV-6 #45)', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
    });
    cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        display_name: 'License Server',
        slug: 'license-server',
        game_port: 7845,
        query_port: 27845,
        beacon_port: 15845,
        rcon_port: 21845,
      },
    });
    expect(resp.statusCode).toBe(201);
    serverId = resp.json<{ id: string }>().id;
    licensePath = `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/License.cfg`;
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('PATCH with license id+key writes License.cfg to disk with plaintext key', async () => {
    const resp = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie },
      payload: { license_id: LICENSE_ID, license_key: LICENSE_KEY },
    });
    expect(resp.statusCode).toBe(200);
    const onDisk = h.bridge.files.get(licensePath);
    expect(onDisk).toBeDefined();
    expect(onDisk?.toString('utf-8')).toBe(`LicenseId=${LICENSE_ID}\nLicenseKey=${LICENSE_KEY}\n`);
    await assertAuditRow(h, { action: 'server.patch', resource: 'server' });
  });

  it('license write inserts a masked config_versions row and no reload', async () => {
    const rows = await h.db
      .select()
      .from(configVersions)
      .where(eq(configVersions.serverId, serverId));
    const licenseRows = rows.filter((r) => r.filename === 'License.cfg');
    expect(licenseRows.length).toBe(1);
    const content = licenseRows[0]?.content ?? '';
    expect(content).toContain('LicenseKey=********');
    expect(content).toContain(`LicenseId=${LICENSE_ID}`);
    expect(content).not.toContain(LICENSE_KEY);
    // No live-reload signal: License.cfg is requires_restart, the license
    // pathway bypasses writeVersion, so no RCON command was ever enqueued.
    expect(await h.redis.xlen(rconCommandStream(serverId))).toBe(0);
  });

  it('GET /servers/:id exposes license state without the key', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      server: {
        license: {
          configured: boolean;
          license_id: string | null;
          updated_at: string | null;
          restart_required: boolean;
        };
      };
    }>();
    expect(body.server.license.configured).toBe(true);
    expect(body.server.license.license_id).toBe(LICENSE_ID);
    expect(body.server.license.updated_at).toEqual(expect.any(String));
    expect(typeof body.server.license.restart_required).toBe('boolean');
    expect(resp.body).not.toContain(LICENSE_KEY);
  });

  it('restart_required flips with container start time', async () => {
    const baseInspect = {
      state: 'running',
      running: true,
      pid: 1,
      finished_at: '',
      exit_code: 0,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
    };
    const getLicense = async () => {
      const resp = await h.app.inject({
        method: 'GET',
        url: `/api/v1/servers/${serverId}`,
        headers: { cookie },
      });
      expect(resp.statusCode).toBe(200);
      return resp.json<{ server: { license: { restart_required: boolean } } }>().server.license;
    };

    // Container started BEFORE the license changed → the running Squad still
    // holds the old (empty) license → restart required.
    h.bridge.containerInspect = async ({ name }) => ({
      ...baseInspect,
      name,
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect((await getLicense()).restart_required).toBe(true);

    // Container (re)started AFTER the license changed → applied.
    h.bridge.containerInspect = async ({ name }) => ({
      ...baseInspect,
      name,
      started_at: new Date(Date.now() + 60 * 1000).toISOString(),
    });
    expect((await getLicense()).restart_required).toBe(false);

    // Not running at all → the license takes effect on next start.
    h.bridge.containerInspect = async ({ name }) => ({
      ...baseInspect,
      name,
      state: 'exited',
      running: false,
      started_at: '',
    });
    expect((await getLicense()).restart_required).toBe(true);
  });

  it('PATCH with only license_key → 422 license_incomplete', async () => {
    const resp = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie },
      payload: { license_key: 'ANOTHER-KEY' },
    });
    expect(resp.statusCode).toBe(422);
    expect(resp.json<{ error: string }>().error).toBe('license_incomplete');
    // Nothing changed on disk.
    expect(h.bridge.files.get(licensePath)?.toString('utf-8')).toBe(
      `LicenseId=${LICENSE_ID}\nLicenseKey=${LICENSE_KEY}\n`,
    );
  });

  it('GET configs/License.cfg is masked; PUT returns 400 panel_managed_file', async () => {
    const read = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/configs/License.cfg`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json<{ content: string }>();
    expect(body.content).toContain('LicenseKey=********');
    expect(read.body).not.toContain(LICENSE_KEY);

    const write = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/configs/License.cfg`,
      headers: { cookie },
      payload: { content: 'LicenseId=evil\nLicenseKey=evil\n' },
    });
    expect(write.statusCode).toBe(400);
    expect(write.json<{ error: string }>().error).toBe('panel_managed_file');

    // Restoring a (masked) history version must be blocked too — it would
    // clobber the real key on disk with the mask.
    const versionRows = await h.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .where(eq(configVersions.serverId, serverId));
    const vid = versionRows[0]?.id;
    expect(vid).toBeDefined();
    const restore = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/configs/License.cfg/restore/${vid}`,
      headers: { cookie },
      payload: {},
    });
    expect(restore.statusCode).toBe(400);
    expect(restore.json<{ error: string }>().error).toBe('panel_managed_file');
  });

  it('detach clears credentials and writes placeholder file', async () => {
    const resp = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie },
      payload: { license_id: null, license_key: null },
    });
    expect(resp.statusCode).toBe(200);
    expect(h.bridge.files.get(licensePath)?.toString('utf-8')).toBe('// Server license key\n');

    const creds = await h.db.query.serverCredentials.findFirst({
      where: eq(serverCredentials.serverId, serverId),
    });
    expect(creds?.licenseId).toBeNull();
    expect(creds?.licenseKeyEncrypted).toBeNull();
    expect(creds?.licenseUpdatedAt).toBeNull();

    const state = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie },
    });
    const license = state.json<{
      server: { license: { configured: boolean; restart_required: boolean } };
    }>().server.license;
    expect(license.configured).toBe(false);
    expect(license.restart_required).toBe(false);
  });
});
