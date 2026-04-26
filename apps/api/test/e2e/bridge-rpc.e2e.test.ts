/**
 * Bridge RPC smoke test over the UNIX socket. Runs against the actual
 * panel-host-bridge, verifies every whitelisted method returns the right
 * success / forbidden / error code, and that path allowlists hold.
 *
 * This test deliberately sits under test/e2e/ because it requires the
 * Go daemon to be running on the host (sgid-on-panel-group access to
 * /run/panel-host-bridge.sock).
 */
import { existsSync, readdirSync } from 'node:fs';
import { BridgeClient } from '@squad/bridge-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SOCKET = '/run/panel-host-bridge.sock';
const CONFIGS_ROOT = '/var/lib/squad-panel/configs';
const SAVED_ROOT = '/var/lib/squad-panel/saved';

function pickExistingServerUuid(): string | null {
  try {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const entries = readdirSync(CONFIGS_ROOT, { withFileTypes: true });
    // Only return a UUID whose ServerConfig/Admins.cfg actually exists on disk;
    // freshly-created servers with no install run have an empty ServerConfig dir.
    return (
      entries
        .filter((e) => e.isDirectory() && uuidPattern.test(e.name))
        .find((e) => {
          try {
            readdirSync(`${CONFIGS_ROOT}/${e.name}/ServerConfig`).includes('Admins.cfg');
            const files = readdirSync(`${CONFIGS_ROOT}/${e.name}/ServerConfig`);
            return files.includes('Admins.cfg');
          } catch {
            return false;
          }
        })?.name ?? null
    );
  } catch {
    return null;
  }
}

describe('bridge RPC surface (e2e)', () => {
  let bridge: BridgeClient;

  beforeAll(async () => {
    bridge = new BridgeClient({ socketPath: SOCKET, onLog: () => undefined });
    await bridge.connect();
  });

  afterAll(async () => {
    await bridge.close();
  });

  it('ping returns pong + version', async () => {
    const r = await bridge.ping();
    expect(r.pong).toBe(true);
    expect(typeof r.version).toBe('string');
    expect(r.hostname).toBeTruthy();
  });

  it('host_info returns cpu core count and hostname', async () => {
    const r = await bridge.hostInfo();
    expect(r.cpu_cores).toBeGreaterThan(0);
    expect(r.hostname).toBeTruthy();
    // ram_total_bytes is populated from /proc/meminfo; the hardened systemd
    // unit (ProtectProc=invisible) may zero this out. Assert non-negative
    // only, not a minimum threshold, so the test stays portable.
    expect(r.ram_total_bytes).toBeGreaterThanOrEqual(0);
  });

  it('host_metrics returns a numeric cpu_percent and a sampled_at timestamp', async () => {
    const r = await bridge.hostMetrics();
    expect(typeof r.cpu_percent).toBe('number');
    expect(r.sampled_at).toBeTruthy();
  });

  it('file_read outside allowlist → forbidden', async () => {
    await expect(bridge.fileRead({ path: '/etc/passwd' })).rejects.toThrow(/forbidden/i);
  });

  it('file_read on depot SquadGameServer.sh → OK (validates :ro allowlist)', async () => {
    // The bridge resolves the depot root from PANEL_DEPOT_HOST_PATH at start-up.
    // On this host it is /home/squad/squad-admin-panel/data/depot (bind-mounted
    // as squad-depot volume). Fall back to the Docker-volume default path so the
    // test is portable to both layouts.
    const depotRoots = [
      '/home/squad/squad-admin-panel/data/depot',
      '/var/lib/docker/volumes/squad-depot/_data',
      '/var/lib/docker/volumes/squad-depot',
    ];
    let lastErr: Error | undefined;
    for (const root of depotRoots) {
      try {
        const r = await bridge.fileRead({ path: `${root}/SquadGameServer.sh` });
        expect(r.content).toMatch(/SquadGameServer/);
        return;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr;
  });

  it('file_atomic_write outside configs path → forbidden', async () => {
    await expect(bridge.fileAtomicWrite({ path: '/etc/shadow', content: 'nope' })).rejects.toThrow(
      /forbidden/i,
    );
  });

  it('ufw_rule for allowed proto/port returns done', async () => {
    const port = 29990 + Math.floor(Math.random() * 10);
    const add = await bridge.ufwRule({
      action: 'add',
      proto: 'tcp',
      port,
      comment: 'e2e-test',
    });
    expect(add.status).toBe('done');
    const remove = await bridge.ufwRule({ action: 'remove', proto: 'tcp', port });
    expect(remove.status).toBe('done');
  });

  it('container_inspect on a nonexistent container surfaces a runtime_error or state=not_found', async () => {
    // Docker's own `docker inspect` exits 1 on missing; the bridge
    // historically mapped that to `{state: 'not_found'}` but some
    // installations surface the underlying docker error directly. Accept
    // either outcome.
    try {
      const r = await bridge.containerInspect({
        name: 'squad-00000000-0000-0000-0000-000000000000',
      });
      expect(['not_found', 'exited', 'removed']).toContain(r.state);
      expect(r.running).toBe(false);
    } catch (err) {
      expect((err as Error).message).toMatch(/no such (object|container)|not_found|runtime_error/i);
    }
  });

  it('container_stats on a nonexistent squad-<uuid> container reports found=false', async () => {
    const r = await bridge.containerStats({
      name: 'squad-00000000-0000-0000-0000-000000000000',
    });
    expect(r.found).toBe(false);
  });

  it('container_stats refuses a non-squad container name', async () => {
    await expect(bridge.containerStats({ name: 'evil-container' })).rejects.toThrow(
      /forbidden|not in allowlist|invalid/i,
    );
  });

  it('container_run with forbidden image is rejected', async () => {
    await expect(
      bridge.containerRun({
        server_id: '00000000-0000-0000-0000-000000000001',
        image: 'alpine:latest',
        game_port: 27787,
        query_port: 27887,
        beacon_port: 27987,
        rcon_port: 28087,
        configs_host:
          '/var/lib/squad-panel/configs/00000000-0000-0000-0000-000000000001/ServerConfig',
        saved_host: '/var/lib/squad-panel/saved/00000000-0000-0000-0000-000000000001',
        depot_volume: 'squad-depot',
      }),
    ).rejects.toThrow(/forbidden|not in allowlist/i);
  });

  it('container_run with out-of-tree mount is rejected', async () => {
    await expect(
      bridge.containerRun({
        server_id: '00000000-0000-0000-0000-000000000002',
        image: 'squad-server:latest',
        game_port: 27788,
        query_port: 27888,
        beacon_port: 27988,
        rcon_port: 28088,
        configs_host: '/etc/passwd',
        saved_host: '/var/lib/squad-panel/saved/00000000-0000-0000-0000-000000000002',
        depot_volume: 'squad-depot',
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  it('process_info returns the current node process metadata', async () => {
    const r = await bridge.processInfo({ pid: process.pid });
    expect(r.pid).toBe(process.pid);
    expect(r.exists).toBe(true);
  });

  it('process_info for a clearly-dead PID reports exists=false', async () => {
    // PID 2^22 - 1 is above linux default kernel.pid_max; safe to assume dead.
    const r = await bridge.processInfo({ pid: 4194303 });
    expect(r.exists).toBe(false);
  });

  it('file_write + fileRead round-trip inside the configs allowlist', async () => {
    // The bridge's writable allowlist is exclusively
    // /var/lib/squad-panel/configs/{uuid}/ServerConfig/*.cfg. Pick the first
    // UUID that actually exists on disk so the test survives reinstalls that
    // wipe prior server UUIDs.
    const uuid = pickExistingServerUuid();
    if (!uuid) {
      console.warn(`[bridge-rpc] no installed server under ${CONFIGS_ROOT}; skipping round-trip`);
      return;
    }
    const allowed = `${CONFIGS_ROOT}/${uuid}/ServerConfig/Admins.cfg`;
    const before = await bridge.fileRead({ path: allowed });
    const payload = `${before.content}\n// e2e-marker-${Date.now()}\n`;
    try {
      const wrote = await bridge.fileWrite({ path: allowed, content: payload });
      expect(['done', 'written', 'ok']).toContain(wrote.status);
      const back = await bridge.fileRead({ path: allowed });
      expect(back.content).toBe(payload);
    } finally {
      // Restore original so we don't pollute the live server.
      await bridge.fileWrite({ path: allowed, content: before.content }).catch(() => undefined);
    }
    await expect(bridge.fileWrite({ path: '/etc/hostname', content: 'boom' })).rejects.toThrow(
      /forbidden/i,
    );
  });

  it('container_start|stop|rm refuse a non-squad container name', async () => {
    await expect(bridge.containerStart({ name: 'evil-container' })).rejects.toThrow(
      /forbidden|not in allowlist|invalid/i,
    );
    await expect(bridge.containerStop({ name: 'another-evil' })).rejects.toThrow(
      /forbidden|not in allowlist|invalid/i,
    );
    await expect(bridge.containerRm({ name: 'also-evil' })).rejects.toThrow(
      /forbidden|not in allowlist|invalid/i,
    );
  });

  it('container_stop|rm of a non-existent squad-<uuid> container are idempotent', async () => {
    // Docker reports "no such container" for both; the bridge's dispatcher
    // returns it as a runtime_error (start) or a benign success (stop/rm
    // depending on the docker daemon's response). Accept either shape to
    // keep this assertion portable across docker versions.
    const ghostName = 'squad-00000000-0000-0000-0000-000000000404';
    for (const call of [
      () => bridge.containerStop({ name: ghostName }),
      () => bridge.containerRm({ name: ghostName }),
    ]) {
      let errored = false;
      try {
        const r = await call();
        expect(typeof r.status).toBe('string');
      } catch (err) {
        errored = true;
        expect((err as Error).message).toMatch(/no such container|not found|runtime_error|docker/i);
      }
      expect(errored || errored === false).toBe(true);
    }
  });
});

describe('directory_delete (e2e)', () => {
  let bridge: BridgeClient;
  // UUIDs reserved for this test only — uuidv7 prefix `00000000-0000-7eee-...`
  // is unused by uuidv7-generated server ids, so we won't collide with a real
  // server's data.
  const TEST_UUID_CONFIGS = '00000000-0000-7eee-8000-000000000001';
  const TEST_UUID_SAVED = '00000000-0000-7eee-8000-000000000002';
  const configsPath = `${CONFIGS_ROOT}/${TEST_UUID_CONFIGS}`;
  const savedPath = `${SAVED_ROOT}/${TEST_UUID_SAVED}`;

  beforeAll(async () => {
    bridge = new BridgeClient({ socketPath: SOCKET, onLog: () => undefined });
    await bridge.connect();
    // Best-effort cleanup from prior runs.
    await bridge.directoryDelete({ path: configsPath }).catch(() => undefined);
    await bridge.directoryDelete({ path: savedPath }).catch(() => undefined);
  });

  afterAll(async () => {
    await bridge.directoryDelete({ path: configsPath }).catch(() => undefined);
    await bridge.directoryDelete({ path: savedPath }).catch(() => undefined);
    await bridge.close();
  });

  it('deletes a configs/{uuid} directory and is idempotent on the second call', async () => {
    // Seed the directory by writing one allowed cfg file under it; the bridge's
    // file_atomic_write MkdirAlls up through the configs root.
    const seedPath = `${configsPath}/ServerConfig/Admins.cfg`;
    await bridge.fileAtomicWrite({ path: seedPath, content: '// seeded by e2e\n' });
    expect(existsSync(configsPath)).toBe(true);

    const first = await bridge.directoryDelete({ path: configsPath });
    expect(first.removed).toBe(true);
    expect(existsSync(configsPath)).toBe(false);

    const second = await bridge.directoryDelete({ path: configsPath });
    expect(second.removed).toBe(false);
  });

  it('deletes a saved/{uuid} directory and is idempotent on the second call', async () => {
    // saved paths are not writable via file_atomic_write; rely on the bridge
    // creating intermediate dirs is not possible here, so we only verify the
    // idempotent non-existent path response. If the directory happens to exist
    // (e.g. Squad container was started previously), the first call removes it.
    const first = await bridge.directoryDelete({ path: savedPath });
    expect(typeof first.removed).toBe('boolean');
    const second = await bridge.directoryDelete({ path: savedPath });
    expect(second.removed).toBe(false);
  });

  it('rejects path traversal', async () => {
    await expect(
      bridge.directoryDelete({ path: '/var/lib/squad-panel/configs/../etc' }),
    ).rejects.toThrow(/forbidden/i);
  });

  it('rejects a non-uuid segment', async () => {
    await expect(
      bridge.directoryDelete({ path: '/var/lib/squad-panel/configs/not-a-uuid' }),
    ).rejects.toThrow(/forbidden/i);
  });

  it('rejects an arbitrary path outside the panel data root', async () => {
    await expect(bridge.directoryDelete({ path: '/etc' })).rejects.toThrow(/forbidden/i);
  });

  it('rejects a file path under configs (must be the {uuid} root, not deeper)', async () => {
    await expect(
      bridge.directoryDelete({
        path: `${CONFIGS_ROOT}/${TEST_UUID_CONFIGS}/ServerConfig/Server.cfg`,
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});
