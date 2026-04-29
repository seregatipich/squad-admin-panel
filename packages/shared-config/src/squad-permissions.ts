export interface SquadPermissionDef {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly dangerous?: true;
}

export const SQUAD_PERMISSIONS = [
  {
    key: 'startvote',
    label: 'startvote',
    description: 'Зарезервировано, пока не используется Squad.',
  },
  {
    key: 'changemap',
    label: 'changemap',
    description: 'Сменить текущую карту (AdminChangeMap / AdminSetNextMap).',
    dangerous: true,
  },
  { key: 'pause', label: 'pause', description: 'Pause / unpause геймплея.' },
  { key: 'cheat', label: 'cheat', description: 'Server cheat commands.' },
  { key: 'private', label: 'private', description: 'Установить пароль на сервер (private mode).' },
  {
    key: 'balance',
    label: 'balance',
    description: 'Игнорировать team balance при смене команды.',
  },
  { key: 'chat', label: 'chat', description: 'Admin chat + server broadcast.' },
  { key: 'kick', label: 'kick', description: 'Кикать игроков.', dangerous: true },
  { key: 'ban', label: 'ban', description: 'Банить игроков.', dangerous: true },
  { key: 'config', label: 'config', description: 'Изменять server config через RCON.' },
  { key: 'cameraman', label: 'cameraman', description: 'Spectator режим (admin cam).' },
  { key: 'immune', label: 'immune', description: 'Невозможно кикнуть или забанить.' },
  {
    key: 'manageserver',
    label: 'manageserver',
    description: 'Shutdown / restart сервера.',
    dangerous: true,
  },
  { key: 'featuretest', label: 'featuretest', description: 'Тестовые фичи от dev team.' },
  { key: 'reserve', label: 'reserve', description: 'Reserved slot.' },
  { key: 'demos', label: 'demos', description: 'Server-side demo recording.' },
  { key: 'clientdemos', label: 'clientdemos', description: 'Client-side demo recording.' },
  { key: 'debug', label: 'debug', description: 'Admin stats + debug info.' },
  { key: 'teamchange', label: 'teamchange', description: 'Без таймера на смену команды.' },
  {
    key: 'forceteamchange',
    label: 'forceteamchange',
    description: 'ForceTeamChange command.',
  },
  {
    key: 'canseeadminchat',
    label: 'canseeadminchat',
    description: 'Видеть admin chat + teamkill notifications.',
  },
] as const satisfies readonly SquadPermissionDef[];

export type SquadPermissionKey = (typeof SQUAD_PERMISSIONS)[number]['key'];
export const SQUAD_PERMISSION_KEYS = SQUAD_PERMISSIONS.map(
  (p) => p.key,
) as readonly SquadPermissionKey[];

const KEY_SET: ReadonlySet<string> = new Set(SQUAD_PERMISSION_KEYS);
export function isSquadPermissionKey(x: string): x is SquadPermissionKey {
  return KEY_SET.has(x);
}

export const DANGEROUS_SQUAD_PERMISSIONS: ReadonlySet<SquadPermissionKey> =
  new Set<SquadPermissionKey>(
    SQUAD_PERMISSIONS.filter(
      (p) => 'dangerous' in p && (p as { dangerous?: boolean }).dangerous === true,
    ).map((p) => p.key as SquadPermissionKey),
  );

export function isDangerousSquadPermission(key: SquadPermissionKey): boolean {
  return DANGEROUS_SQUAD_PERMISSIONS.has(key);
}
