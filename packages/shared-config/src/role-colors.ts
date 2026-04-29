// Tailwind palette names — kept for back-compat with pre-Эпик-2-Phase-2
// seed roles. The DB CHECK accepts either a palette name or a hex code.
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
export type RoleColorName = (typeof ROLE_COLORS)[number];

export const ROLE_COLOR_SET: ReadonlySet<string> = new Set(ROLE_COLORS);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export type RoleColor = RoleColorName | `#${string}`;

export function isRoleColor(x: string): x is RoleColor {
  return ROLE_COLOR_SET.has(x) || HEX_RE.test(x);
}

export function isRoleColorPaletteName(x: string): x is RoleColorName {
  return ROLE_COLOR_SET.has(x);
}

export function isRoleColorHex(x: string): x is `#${string}` {
  return HEX_RE.test(x);
}

const PALETTE_HEX: Readonly<Record<RoleColorName, string>> = {
  red: '#EF4444',
  rose: '#F43F5E',
  pink: '#EC4899',
  fuchsia: '#D946EF',
  purple: '#A855F7',
  violet: '#8B5CF6',
  indigo: '#6366F1',
  blue: '#3B82F6',
  sky: '#0EA5E9',
  cyan: '#06B6D4',
  teal: '#14B8A6',
  emerald: '#10B981',
  green: '#22C55E',
  lime: '#84CC16',
  amber: '#F59E0B',
  neutral: '#737373',
};

export function roleColorToHex(color: string): string {
  if (HEX_RE.test(color)) return color.toUpperCase();
  if (color in PALETTE_HEX) return PALETTE_HEX[color as RoleColorName];
  return '#737373';
}
