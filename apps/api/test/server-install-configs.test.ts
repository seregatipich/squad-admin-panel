/**
 * Regression guard for the PANEL_DEPOT_HOST_PATH fix.
 *
 * Before the fix, `seedConfigs` read the SteamCMD depot defaults through
 * `/var/lib/docker/volumes/squad-depot/_data/...`, which Docker does not
 * populate for bind-mounted named volumes. The bridge returned ENOENT, the
 * install flow swallowed the error, and every new server got 19 zero-byte
 * cfg files. The fix plumbs PANEL_DEPOT_HOST_PATH through the API so the
 * operator can point at the real bind-mount source.
 *
 * This suite exercises the three shapes that matter:
 *   A) env unset → reads from the historical `/var/lib/docker/volumes/...`
 *      stub; proves we did not change the prod default.
 *   B) env set to a custom path (e.g. `${DATA_DIR}/depot`) → reads from
 *      that path; this is the regression guard for the original bug.
 *   C) one cfg file missing from depot → the existing "creating empty"
 *      fallback still fires and does not crash seedConfigs.
 */
import { adminsCfgSyncOutbox, configVersions, servers } from '@squad/db/schema';
import { DEPOT_VOLUME_NAME } from '@squad/shared-config';
import { eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { relaunchSidecar } from '../src/lib/rnsquadjs.js';
import { markServerRunningAndEnqueue } from '../src/routes/server-install.js';
import {
  buildIntegrationApp,
  type FakeBridge,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

// The relaunch helpers write real files under /run; stub them so install tests
// never touch the host's runtime dir. What env the sidecar is launched with is
// covered by test/lib/rnsquadjs.test.ts; here the install-specific behaviour matters:
// the sidecar is launched at all, and its failure never fails the install.
vi.mock('../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/rnsquadjs.js')>()),
  writeSidecarConfig: vi.fn().mockResolvedValue(undefined),
  relaunchSidecar: vi.fn().mockResolvedValue({ containerId: 'rnsquadjs-xyz', mode: 'shadow' }),
}));

const OWNER_STEAM_ID = 76561198000000999n;

const createBody = {
  display_name: 'Depot Seed Test',
  slug: 'depot-seed-test',
  description: 'depot seeding regression fixture',
  game_port: 7787,
  query_port: 27165,
  beacon_port: 15000,
  rcon_port: 21114,
  max_players: 80,
  tickrate: 50,
  multihome: '0.0.0.0',
  extra_args: '',
};

// Synthetic SteamCMD-shaped contents, sized roughly like the real depot
// templates so the test catches "wrote zero bytes" regressions.
const SYNTHETIC_CONTENTS: Record<string, string> = {
  'Admins.cfg': `// Squad admin groups + assignments\nGroup=SuperAdmin:changemap,kick,ban\n${'// placeholder\n'.repeat(40)}`,
  'Bans.cfg': '// Offline bans file\n',
  'CustomOptions.cfg': `// Custom server options\nCustomString1=""\n${'// filler\n'.repeat(25)}`,
  'ExcludedFactions.cfg': '// factions excluded from matchmaking\n',
  'ExcludedLayers.cfg': '// layers excluded from rotation\n',
  'ExcludedLevels.cfg': '// levels excluded\n',
  'LayerRotation.cfg': `// Layer rotation\n${'AAS:Narva_AAS_v1\n'.repeat(15)}`,
  'LayerVoting.cfg': '// Layer voting pool\n',
  'LayerVotingLowPlayers.cfg': '// Low-player layer voting pool\n',
  'LayerVotingNight.cfg': '// Night-time layer voting pool\n',
  'LevelRotation.cfg': '// Level rotation\n',
  'License.cfg': '// Server license key\n',
  'MOTD.cfg': '// Message of the day\nWelcome!\n',
  'Rcon.cfg': `Port=12345\nPassword=depot-template-placeholder\nIP=0.0.0.0\n// Rcon settings\n${'// filler\n'.repeat(10)}`,
  'RemoteAdminListHosts.cfg': '// Remote admin list HTTPS endpoints\n',
  'RemoteBanListHosts.cfg': '// Remote ban list HTTPS endpoints\n',
  'Server.cfg': `ServerName="Squad Dedicated Server"\nMaxPlayers=80\n${'// filler\n'.repeat(30)}`,
  'ServerMessages.cfg': '// In-game server messages\n',
  'VoteConfig.cfg': '// Voting configuration\n',
};

function seedDepotFiles(bridge: FakeBridge, depotRoot: string): void {
  bridge.files.set(
    `${depotRoot}/SquadGameServer.sh`,
    Buffer.from('#!/bin/sh\nexec ./SquadGameServer "$@"\n', 'utf-8'),
  );
  for (const [name, content] of Object.entries(SYNTHETIC_CONTENTS)) {
    bridge.files.set(`${depotRoot}/SquadGame/ServerConfig/${name}`, Buffer.from(content, 'utf-8'));
  }
}

async function loginAs(h: IntegrationHarness): Promise<string> {
  return loginAsOwner(h);
}

async function createServer(h: IntegrationHarness, cookie: string): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: createBody,
  });
  if (resp.statusCode !== 201) throw new Error(`create failed: ${resp.body}`);
  return resp.json<{ id: string }>().id;
}

async function runInstallAndWaitForDone(
  h: IntegrationHarness,
  cookie: string,
  serverId: string,
): Promise<{ step: string; message: string }[]> {
  const post = await h.app.inject({
    method: 'POST',
    url: `/api/v1/servers/${serverId}/install`,
    headers: { cookie },
  });
  if (post.statusCode !== 200) throw new Error(`install post failed: ${post.body}`);

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const lines = h.app.installProgress.snapshot(serverId);
    if (lines.some((l) => l.step === 'done' || l.step === 'error')) {
      const terminal = lines.find((l) => l.step === 'done' || l.step === 'error');
      // The `some(...)` check above used the identical predicate, so a match exists.
      if (!terminal) throw new Error('expected a terminal install progress line');
      if (terminal.step === 'error') {
        throw new Error(`install errored: ${terminal.message}`);
      }
      return lines;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `install did not complete within 8s; last progress: ${JSON.stringify(
      h.app.installProgress.snapshot(serverId).slice(-5),
    )}`,
  );
}

describe('server install depot seeding', () => {
  let h: IntegrationHarness;
  let bridge: FakeBridge;

  beforeAll(async () => {
    bridge = makeFakeBridge();
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID }, bridge });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  // Every case creates a server with the same slug and ports, which only one
  // active server may hold, and seeds its own depot layout into the fake host
  // filesystem; release both so the next case starts from an empty host.
  afterEach(async () => {
    vi.unstubAllEnvs();
    bridge.files.clear();
    await h.db.update(servers).set({ deletedAt: new Date() }).where(isNull(servers.deletedAt));
  });

  describe('A) PANEL_DEPOT_HOST_PATH unset — legacy /var/lib/docker/volumes/... default', () => {
    const depotRoot = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data`;

    beforeEach(() => {
      vi.stubEnv('PANEL_DEPOT_HOST_PATH', '');
      seedDepotFiles(bridge, depotRoot);
    });

    it('seeds 19 non-empty cfg files + config_versions rows from the default depot root', async () => {
      const cookie = await loginAs(h);
      const serverId = await createServer(h, cookie);
      await runInstallAndWaitForDone(h, cookie, serverId);

      const versions = await h.db
        .select()
        .from(configVersions)
        .where(eq(configVersions.serverId, serverId));
      expect(versions).toHaveLength(19);
      for (const v of versions) {
        expect(v.content.length).toBeGreaterThan(0);
      }

      const destDir = `/var/lib/squad-panel/configs/${serverId}/ServerConfig`;
      for (const name of Object.keys(SYNTHETIC_CONTENTS)) {
        const buf = bridge.files.get(`${destDir}/${name}`);
        expect(buf, `${name} should be written`).toBeDefined();
        expect(buf?.length).toBeGreaterThan(0);
      }

      const [row] = await h.db.select().from(servers).where(eq(servers.id, serverId));
      expect(row?.status).toBe('running');
    });
  });

  describe('B) PANEL_DEPOT_HOST_PATH=/opt/panel-data/depot — bind-mounted depot regression guard', () => {
    const depotRoot = '/opt/panel-data/depot';

    beforeEach(() => {
      vi.stubEnv('PANEL_DEPOT_HOST_PATH', depotRoot);
      seedDepotFiles(bridge, depotRoot);
    });

    it('reads depot defaults from the env-override path (not the legacy stub)', async () => {
      const cookie = await loginAs(h);
      const serverId = await createServer(h, cookie);
      await runInstallAndWaitForDone(h, cookie, serverId);

      const versions = await h.db
        .select()
        .from(configVersions)
        .where(eq(configVersions.serverId, serverId));
      expect(versions).toHaveLength(19);

      const destDir = `/var/lib/squad-panel/configs/${serverId}/ServerConfig`;
      for (const name of Object.keys(SYNTHETIC_CONTENTS)) {
        const buf = bridge.files.get(`${destDir}/${name}`);
        expect(buf, `${name} should be written under ${destDir}`).toBeDefined();
        expect(buf?.length).toBeGreaterThan(0);
      }

      // Rcon.cfg is a SYNTHETIC_CONTENTS key, so the loop above already
      // asserted it was written; the non-null cast is safe here.
      const rcon = (bridge.files.get(`${destDir}/Rcon.cfg`) as Buffer).toString('utf-8');
      expect(rcon).toMatch(/Password=.+/);
      expect(rcon).toMatch(new RegExp(`Port=${createBody.rcon_port}`));
      expect(rcon).not.toMatch(/depot-template-placeholder/);

      // Server.cfg is likewise a SYNTHETIC_CONTENTS key already asserted above.
      const serverCfg = (bridge.files.get(`${destDir}/Server.cfg`) as Buffer).toString('utf-8');
      expect(serverCfg).toMatch(new RegExp(`ServerName="${createBody.display_name}"`));

      const rconVersion = versions.find((v) => v.filename === 'Rcon.cfg');
      expect(rconVersion?.content).toMatch(new RegExp(`Port=${createBody.rcon_port}`));

      const legacyStubDir = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/SquadGame/ServerConfig`;
      expect(bridge.files.get(`${legacyStubDir}/Admins.cfg`)).toBeUndefined();
    });
  });

  describe('C) one depot file missing — "creating empty" fallback still fires', () => {
    const depotRoot = '/opt/panel-data/depot';

    beforeEach(() => {
      vi.stubEnv('PANEL_DEPOT_HOST_PATH', depotRoot);
      seedDepotFiles(bridge, depotRoot);
      bridge.files.delete(`${depotRoot}/SquadGame/ServerConfig/Admins.cfg`);
    });

    it('writes 0-byte Admins.cfg, logs the fallback, still seeds the other 18', async () => {
      const cookie = await loginAs(h);
      const serverId = await createServer(h, cookie);
      const lines = await runInstallAndWaitForDone(h, cookie, serverId);

      const fallbackLine = lines.find(
        (l) => l.step === 'configs' && /Admins\.cfg not in depot/.test(l.message),
      );
      expect(fallbackLine, 'expected a creating-empty log line for Admins.cfg').toBeDefined();

      const destDir = `/var/lib/squad-panel/configs/${serverId}/ServerConfig`;
      const admins = bridge.files.get(`${destDir}/Admins.cfg`);
      expect(admins).toBeDefined();
      expect(admins?.length).toBe(0);

      const versions = await h.db
        .select()
        .from(configVersions)
        .where(eq(configVersions.serverId, serverId));
      expect(versions).toHaveLength(19);
      const adminsRow = versions.find((v) => v.filename === 'Admins.cfg');
      expect(adminsRow?.content).toBe('');
    });
  });

  describe('D) rnsquadjs sidecar launch', () => {
    const depotRoot = '/opt/panel-data/depot';

    beforeEach(() => {
      vi.stubEnv('PANEL_DEPOT_HOST_PATH', depotRoot);
      seedDepotFiles(bridge, depotRoot);
    });

    it('launches the sidecar for the assigned engine and seeds the ro Logs bind source', async () => {
      vi.mocked(relaunchSidecar).mockClear();

      const cookie = await loginAs(h);
      const serverId = await createServer(h, cookie);
      await runInstallAndWaitForDone(h, cookie, serverId);

      // A fresh id is in neither the engine set nor the cutover set, so install
      // takes the RNSquadJS path in shadow mode.
      expect(relaunchSidecar).toHaveBeenCalledTimes(1);
      expect(relaunchSidecar).toHaveBeenCalledWith(expect.anything(), serverId);

      // The bridge bind-mounts <saved>/<id>/SquadGame/Saved/Logs read-only;
      // install must create that dir (via a .keep file) before the sidecar
      // starts, otherwise the ro bind has no source.
      expect(
        bridge.files.get(`/var/lib/squad-panel/saved/${serverId}/SquadGame/Saved/Logs/.keep`),
      ).toBeDefined();
    });

    it('completes the install even when the sidecar launch rejects (non-fatal)', async () => {
      vi.mocked(relaunchSidecar).mockRejectedValueOnce(new Error('rnsquadjs image missing'));

      const cookie = await loginAs(h);
      const serverId = await createServer(h, cookie);
      // runInstallAndWaitForDone throws on a terminal 'error' step; the sidecar
      // failure must not produce one — the install still reaches 'done'.
      await runInstallAndWaitForDone(h, cookie, serverId);

      const [row] = await h.db.select().from(servers).where(eq(servers.id, serverId));
      expect(row?.status).toBe('running');
    });
  });

  describe('E) running transition and initial Admins.cfg outbox', () => {
    const depotRoot = '/opt/panel-data/depot';

    beforeEach(() => {
      vi.stubEnv('PANEL_DEPOT_HOST_PATH', depotRoot);
      seedDepotFiles(bridge, depotRoot);
    });

    it('commits running and exactly one outbox row together', async () => {
      const cookie = await loginAs(h);
      const serverId = await createServer(h, cookie);

      await markServerRunningAndEnqueue(h.db, serverId, 'container-atomic', {
        reason: 'server.install.completed',
        actor_player_id: null,
        enqueued_at: new Date().toISOString(),
      });

      const [server] = await h.db.select().from(servers).where(eq(servers.id, serverId));
      const tasks = await h.db
        .select()
        .from(adminsCfgSyncOutbox)
        .where(eq(adminsCfgSyncOutbox.serverId, serverId));
      expect(server).toMatchObject({ status: 'running', containerId: 'container-atomic' });
      expect(tasks).toHaveLength(1);
    });

    it('rolls back running when the outbox payload cannot be inserted', async () => {
      const cookie = await loginAs(h);
      const serverId = await createServer(h, cookie);
      await h.db.update(servers).set({ status: 'installing' }).where(eq(servers.id, serverId));

      await expect(
        markServerRunningAndEnqueue(h.db, serverId, 'container-must-rollback', {
          reason: 'server.install.completed',
          // A bigint cannot be encoded as JSONB. This forces the outbox insert
          // to fail after the UPDATE has executed inside the real PG transaction.
          actor_player_id: 1n as never,
          enqueued_at: new Date().toISOString(),
        }),
      ).rejects.toThrow();

      const [server] = await h.db.select().from(servers).where(eq(servers.id, serverId));
      const tasks = await h.db
        .select()
        .from(adminsCfgSyncOutbox)
        .where(eq(adminsCfgSyncOutbox.serverId, serverId));
      expect(server).toMatchObject({ status: 'installing', containerId: null });
      expect(tasks).toHaveLength(0);
    });
  });
});
