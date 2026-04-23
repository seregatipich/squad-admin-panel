export const BRIDGE_METHODS = [
  'ping',
  'host_info',
  'host_metrics',
  'systemctl_action',
  'systemctl_write_unit',
  'systemctl_read_unit',
  'systemctl_daemon_reload',
  'steamcmd_run',
  'apt_install',
  'file_read',
  'file_write',
  'file_atomic_write',
  'process_info',
  'journalctl_follow',
  'ufw_rule',
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export const BRIDGE_STREAMING_METHODS: readonly BridgeMethod[] = [
  'steamcmd_run',
  'journalctl_follow',
];

export const BRIDGE_ALLOWED_APT_PACKAGES = [
  'lib32gcc-s1',
  'lib32stdc++6',
  'libc6-i386',
  'libsdl2-2.0-0:i386',
  'curl',
  'wget',
  'ca-certificates',
  'tar',
  'locales',
  'file',
  'bsdmainutils',
  'python3',
  'tmux',
  'screen',
] as const;

export type AllowedAptPackage = (typeof BRIDGE_ALLOWED_APT_PACKAGES)[number];

export const BRIDGE_SOCKET_DEFAULT = '/run/panel-host-bridge.sock';
export const BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const SQUAD_APP_ID = 403240;
export const SQUAD_SERVERS_ROOT = '/opt/squad-servers';
export const SQUAD_UNIT_PREFIX = 'squad-server-';
export const SQUAD_UNIT_REGEX = /^squad-server-[a-f0-9-]{36}\.service$/;
export const SQUAD_INSTALL_PATH_REGEX =
  /^\+force_install_dir \/opt\/squad-servers\/[a-f0-9-]{36}\/?$/;
