export const PERMISSION_CATEGORIES = [
  'servers',
  'configs',
  'players',
  'moderation',
  'admin_groups',
  'whitelist',
  'host',
  'audit',
  'events',
  'users',
  'roles',
  'backup',
  'api_tokens',
  'discord',
  'triggers',
  'scheduler',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export interface PermissionDef {
  readonly key: string;
  readonly category: PermissionCategory;
  readonly label: string;
  readonly dangerous?: true;
  readonly unimplemented?: true;
}

export const PERMISSIONS = [
  { key: 'server:view', category: 'servers', label: 'Видеть серверы и их статус' },
  { key: 'server:install', category: 'servers', label: 'Устанавливать серверы', dangerous: true },
  { key: 'server:start', category: 'servers', label: 'Start сервера' },
  { key: 'server:stop', category: 'servers', label: 'Stop (graceful)' },
  { key: 'server:force_stop', category: 'servers', label: 'Force-stop (kill)', dangerous: true },
  { key: 'server:restart', category: 'servers', label: 'Restart' },
  {
    key: 'server:delete',
    category: 'servers',
    label: 'Удалить сервер с очисткой',
    dangerous: true,
  },
  {
    key: 'server:edit_settings',
    category: 'servers',
    label: 'Resource limits, ports, max_players',
  },
  { key: 'server:update', category: 'servers', label: 'app_update через SteamCMD' },
  { key: 'config:view', category: 'configs', label: 'Читать .cfg файлы' },
  { key: 'config:edit', category: 'configs', label: 'Редактировать через Monaco' },
  { key: 'config:rollback', category: 'configs', label: 'Откат к предыдущей версии' },
  { key: 'player:view', category: 'players', label: 'Список игроков, ник, SteamID' },
  { key: 'player:view_ips', category: 'players', label: 'История IP' },
  {
    key: 'player:view_notes',
    category: 'players',
    label: 'Заметки про игрока',
    unimplemented: true,
  },
  {
    key: 'player:edit_notes',
    category: 'players',
    label: 'Редактировать заметки',
    unimplemented: true,
  },
  {
    key: 'player:set_flags',
    category: 'players',
    label: 'Custom теги (toxic, helpful)',
    unimplemented: true,
  },
  {
    key: 'mod:kick',
    category: 'moderation',
    label: 'Kick через UI',
    dangerous: true,
    unimplemented: true,
  },
  { key: 'mod:warn', category: 'moderation', label: 'Warn', unimplemented: true },
  {
    key: 'mod:ban_temp',
    category: 'moderation',
    label: 'Temp ban',
    dangerous: true,
    unimplemented: true,
  },
  {
    key: 'mod:ban_perm',
    category: 'moderation',
    label: 'Permanent ban',
    dangerous: true,
    unimplemented: true,
  },
  { key: 'mod:unban', category: 'moderation', label: 'Unban', unimplemented: true },
  {
    key: 'admin_group:view',
    category: 'admin_groups',
    label: 'Видеть Admins.cfg',
  },
  {
    key: 'admin_group:edit',
    category: 'admin_groups',
    label: 'Редактировать Admins.cfg',
  },
  { key: 'whitelist:view', category: 'whitelist', label: 'Видеть whitelist' },
  {
    key: 'whitelist:edit',
    category: 'whitelist',
    label: 'Управлять whitelist',
  },
  { key: 'host:view', category: 'host', label: 'Dashboard host info' },
  { key: 'host:metrics', category: 'host', label: 'Метрики (CPU/RAM/Disk/Net + история)' },
  {
    key: 'host:manage',
    category: 'host',
    label: 'Управление хост-демоном (restart bridge)',
    dangerous: true,
  },
  { key: 'audit:view', category: 'audit', label: 'Читать audit log' },
  { key: 'audit:export', category: 'audit', label: 'Export audit в CSV', unimplemented: true },
  { key: 'events:view', category: 'events', label: 'Game events log' },
  { key: 'user:view', category: 'users', label: 'Список пользователей панели' },
  { key: 'user:manage_roles', category: 'users', label: 'Назначать роли', dangerous: true },
  { key: 'role:view', category: 'roles', label: 'Видеть роли' },
  { key: 'role:create', category: 'roles', label: 'Создавать роли' },
  { key: 'role:edit', category: 'roles', label: 'Редактировать роли' },
  { key: 'role:delete', category: 'roles', label: 'Удалять роли', dangerous: true },
  { key: 'backup:view', category: 'backup', label: 'Список backups', unimplemented: true },
  { key: 'backup:trigger', category: 'backup', label: 'Запустить backup', unimplemented: true },
  {
    key: 'backup:restore',
    category: 'backup',
    label: 'Restore из snapshot',
    dangerous: true,
    unimplemented: true,
  },
  { key: 'api_token:create', category: 'api_tokens', label: 'Создавать API tokens' },
  { key: 'api_token:revoke', category: 'api_tokens', label: 'Ревокать tokens' },
  { key: 'discord:link', category: 'discord', label: 'Привязать Discord', unimplemented: true },
  {
    key: 'integration:manage',
    category: 'discord',
    label: 'Управлять интеграциями (Discord)',
    dangerous: true,
  },
  { key: 'trigger:view', category: 'triggers', label: 'Видеть авто-правила', unimplemented: true },
  {
    key: 'trigger:edit',
    category: 'triggers',
    label: 'Редактировать авто-правила',
    unimplemented: true,
  },
  {
    key: 'scheduler:view',
    category: 'scheduler',
    label: 'Видеть запланированные задачи',
    unimplemented: true,
  },
  {
    key: 'scheduler:edit',
    category: 'scheduler',
    label: 'Редактировать расписание',
    unimplemented: true,
  },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as readonly PermissionKey[];

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);
export function isPermissionKey(x: string): x is PermissionKey {
  return PERMISSION_KEY_SET.has(x);
}
