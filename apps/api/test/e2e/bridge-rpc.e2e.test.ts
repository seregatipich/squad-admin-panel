/**
 * Bridge RPC smoke test over the UNIX socket. Runs against the actual
 * panel-host-bridge, verifies every whitelisted method returns the right
 * success / forbidden / error code, and that path allowlists hold.
 *
 * This test deliberately sits under test/e2e/ because it requires the
 * Go daemon to be running on the host (sgid-on-panel-group access to
 * /run/panel-host-bridge.sock).
 */
import { BridgeClient } from '@squad/bridge-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SOCKET = '/run/panel-host-bridge.sock';

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

  it('host_info returns real cpu/ram data', async () => {
    const r = await bridge.hostInfo();
    expect(r.cpu_cores).toBeGreaterThan(0);
    expect(r.ram_total_bytes).toBeGreaterThan(1024 * 1024 * 1024);
  });

  it('host_metrics returns rates', async () => {
    const r = await bridge.hostMetrics();
    expect(typeof r.cpu_percent).toBe('number');
    expect(r.ram_used_bytes).toBeGreaterThan(0);
  });

  it('file_read outside allowlist → forbidden', async () => {
    await expect(bridge.fileRead({ path: '/etc/passwd' })).rejects.toThrow(/forbidden/i);
  });

  it('file_read on depot SquadGameServer.sh → OK (validates :ro allowlist)', async () => {
    const r = await bridge.fileRead({
      path: '/var/lib/docker/volumes/squad-depot/_data/SquadGameServer.sh',
    });
    expect(r.content).toMatch(/SquadGameServer/);
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

  it('container_inspect on nonexistent container returns state=not_found', async () => {
    const r = await bridge.containerInspect({
      name: 'squad-00000000-0000-0000-0000-000000000000',
    });
    expect(r.state).toBe('not_found');
    expect(r.running).toBe(false);
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
});
