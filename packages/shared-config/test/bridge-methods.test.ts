import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CONFIG_FILES,
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_METHODS,
  BRIDGE_SOCKET_DEFAULT,
  BRIDGE_STREAMING_METHODS,
  configFileClass,
  DEPOT_INIT_IMAGE,
  DEPOT_VOLUME_NAME,
  HOT_RELOAD_FILES,
  PANEL_CONFIGS_ROOT,
  PANEL_DATA_ROOT,
  PANEL_SAVED_ROOT,
  ROTATION_FILES,
  SERVER_CONTAINER_PREFIX,
  SERVER_CONTAINER_REGEX,
  SERVER_IMAGE,
  SQUAD_APP_ID,
} from '../src/bridge-methods.js';

describe('bridge methods constants', () => {
  it('lists exactly the methods the bridge whitelists', () => {
    expect(BRIDGE_METHODS).toEqual([
      'ping',
      'host_info',
      'host_metrics',
      'file_read',
      'file_read_tail',
      'file_write',
      'file_atomic_write',
      'directory_delete',
      'list_panel_dirs',
      'list_squad_containers',
      'ufw_rule',
      'process_info',
      'container_run',
      'container_run_rnsquadjs',
      'container_start',
      'container_stop',
      'container_rm',
      'container_inspect',
      'container_stats',
      'container_logs_follow',
      'depot_update',
      'docker_prune',
      'backup_snapshots',
      'backup_run',
      'backup_restore',
      'panel_disk_usage',
      'squad_log_retention_sweep',
      'squad_log_list',
      'file_read_stream',
      'host_agent_restart',
    ]);
  });

  it('exposes the streaming subset that the multiplexer must serialize', () => {
    expect(BRIDGE_STREAMING_METHODS).toEqual([
      'container_logs_follow',
      'depot_update',
      'docker_prune',
      'backup_run',
      'backup_restore',
      'file_read_stream',
    ]);
    for (const m of BRIDGE_STREAMING_METHODS) {
      expect(BRIDGE_METHODS).toContain(m);
    }
  });

  it('exposes the bridge socket path the host daemon binds to', () => {
    expect(BRIDGE_SOCKET_DEFAULT).toBe('/run/panel-host-bridge/bridge.sock');
  });

  it('caps frames at 16 MiB to match the Go-side decoder limit', () => {
    expect(BRIDGE_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
  });

  it('uses the Squad public dedicated-server SteamCMD app id', () => {
    expect(SQUAD_APP_ID).toBe(403_240);
  });

  it('roots panel state under /var/lib/squad-panel', () => {
    expect(PANEL_DATA_ROOT).toBe('/var/lib/squad-panel');
    expect(PANEL_CONFIGS_ROOT).toBe('/var/lib/squad-panel/configs');
    expect(PANEL_SAVED_ROOT).toBe('/var/lib/squad-panel/saved');
  });

  it('exposes the depot volume + image identifiers', () => {
    expect(DEPOT_VOLUME_NAME).toBe('squad-depot');
    expect(SERVER_IMAGE).toBe('squad-server:latest');
    expect(DEPOT_INIT_IMAGE).toBe('squad-panel/depot-init:latest');
  });

  it('matches a properly-named per-server container', () => {
    expect(SERVER_CONTAINER_PREFIX).toBe('squad-');
    expect(SERVER_CONTAINER_REGEX.test('squad-01999999-9999-7999-8999-999999999999')).toBe(true);
    expect(SERVER_CONTAINER_REGEX.test('squad-not-a-uuid')).toBe(false);
    expect(SERVER_CONTAINER_REGEX.test('postgres')).toBe(false);
  });
});

describe('configFileClass', () => {
  it('classifies hot-reload files', () => {
    for (const f of HOT_RELOAD_FILES) {
      expect(configFileClass(f)).toBe('hot_reload');
    }
  });

  it('classifies rotation files', () => {
    for (const f of ROTATION_FILES) {
      expect(configFileClass(f)).toBe('rotation');
    }
  });

  it('falls through to requires_restart for everything else', () => {
    expect(configFileClass('Server.cfg')).toBe('requires_restart');
    expect(configFileClass('Rcon.cfg')).toBe('requires_restart');
    expect(configFileClass('License.cfg')).toBe('requires_restart');
    expect(configFileClass('MOTD.cfg')).toBe('requires_restart');
    expect(configFileClass('CustomOptions.cfg')).toBe('requires_restart');
    expect(configFileClass('ServerMessages.cfg')).toBe('requires_restart');
  });

  it('classifies every entry in ALLOWED_CONFIG_FILES exactly once', () => {
    for (const f of ALLOWED_CONFIG_FILES) {
      const c = configFileClass(f);
      expect(['hot_reload', 'rotation', 'requires_restart']).toContain(c);
    }
  });
});
