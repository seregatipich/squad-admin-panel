export const ROLE_COLORS = [
  'red',
  'rose',
  'pink',
  'fuchsia',
  'purple',
  'violet',
  'indigo',
  'blue',
  'sky',
  'cyan',
  'teal',
  'emerald',
  'green',
  'lime',
  'amber',
  'neutral',
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];

export const ROLE_COLOR_SET: ReadonlySet<string> = new Set(ROLE_COLORS);
export function isRoleColor(x: string): x is RoleColor {
  return ROLE_COLOR_SET.has(x);
}
