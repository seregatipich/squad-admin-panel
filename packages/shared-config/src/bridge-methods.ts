export const BRIDGE_METHODS = [
  'ping',
  'host_info',
  'host_metrics',
  'file_read',
  'file_write',
  'file_atomic_write',
  'directory_delete',
  'ufw_rule',
  'process_info',
  'container_run',
  'container_start',
  'container_stop',
  'container_rm',
  'container_inspect',
  'container_stats',
  'container_logs_follow',
  'depot_update',
  'host_agent_restart',
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export const BRIDGE_STREAMING_METHODS: readonly BridgeMethod[] = [
  'container_logs_follow',
  'depot_update',
];

export const BRIDGE_SOCKET_DEFAULT = '/run/panel-host-bridge.sock';
export const BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const SQUAD_APP_ID = 403240;

export const PANEL_DATA_ROOT = '/var/lib/squad-panel';
export const PANEL_CONFIGS_ROOT = `${PANEL_DATA_ROOT}/configs`;
export const PANEL_SAVED_ROOT = `${PANEL_DATA_ROOT}/saved`;

export const DEPOT_VOLUME_NAME = 'squad-depot';
export const SERVER_IMAGE = 'squad-server:latest';
export const DEPOT_INIT_IMAGE = 'squad-panel/depot-init:latest';

export const SERVER_CONTAINER_PREFIX = 'squad-';
export const SERVER_CONTAINER_REGEX =
  /^squad-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export const ALLOWED_CONFIG_FILES = [
  'Admins.cfg',
  'Bans.cfg',
  'CustomOptions.cfg',
  'ExcludedFactions.cfg',
  'ExcludedLayers.cfg',
  'ExcludedLevels.cfg',
  'LayerRotation.cfg',
  'LayerVoting.cfg',
  'LayerVotingLowPlayers.cfg',
  'LayerVotingNight.cfg',
  'LevelRotation.cfg',
  'License.cfg',
  'MOTD.cfg',
  'Rcon.cfg',
  'RemoteAdminListHosts.cfg',
  'RemoteBanListHosts.cfg',
  'Server.cfg',
  'ServerMessages.cfg',
  'VoteConfig.cfg',
] as const;

export type AllowedConfigFile = (typeof ALLOWED_CONFIG_FILES)[number];

// Files Squad re-reads live from disk without needing a restart.
// Everything else in ALLOWED_CONFIG_FILES \ HOT_RELOAD_FILES requires
// the operator to restart the container.
export const HOT_RELOAD_FILES: readonly AllowedConfigFile[] = [
  'Admins.cfg',
  'Bans.cfg',
  'RemoteAdminListHosts.cfg',
  'RemoteBanListHosts.cfg',
];

export const ROTATION_FILES: readonly AllowedConfigFile[] = [
  'LayerRotation.cfg',
  'LevelRotation.cfg',
  'ExcludedLayers.cfg',
  'ExcludedLevels.cfg',
  'ExcludedFactions.cfg',
  'LayerVoting.cfg',
  'LayerVotingLowPlayers.cfg',
  'LayerVotingNight.cfg',
  'VoteConfig.cfg',
];

export function configFileClass(
  name: AllowedConfigFile,
): 'hot_reload' | 'rotation' | 'requires_restart' {
  if (HOT_RELOAD_FILES.includes(name)) return 'hot_reload';
  if (ROTATION_FILES.includes(name)) return 'rotation';
  return 'requires_restart';
}
