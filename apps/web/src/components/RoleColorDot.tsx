import {
  isRoleColorHex,
  isRoleColorPaletteName,
  type RoleColor,
} from '@squad/shared-config/role-colors';

const CLASS_MAP: Record<string, string> = {
  red: 'bg-red-500',
  rose: 'bg-rose-500',
  pink: 'bg-pink-500',
  fuchsia: 'bg-fuchsia-500',
  purple: 'bg-purple-500',
  violet: 'bg-violet-500',
  indigo: 'bg-indigo-500',
  blue: 'bg-blue-500',
  sky: 'bg-sky-500',
  cyan: 'bg-cyan-500',
  teal: 'bg-teal-500',
  emerald: 'bg-emerald-500',
  green: 'bg-green-500',
  lime: 'bg-lime-500',
  amber: 'bg-amber-500',
  neutral: 'bg-neutral-500',
};

export function RoleColorDot({
  color,
  size = 'md',
}: {
  color: RoleColor | string;
  size?: 'sm' | 'md';
}) {
  const dim = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';
  if (typeof color === 'string' && isRoleColorHex(color)) {
    return (
      <span
        aria-hidden
        className={`inline-block rounded-full ${dim}`}
        style={{ backgroundColor: color }}
      />
    );
  }
  const cls = isRoleColorPaletteName(color) ? CLASS_MAP[color] : 'bg-neutral-500';
  return <span aria-hidden className={`inline-block rounded-full ${dim} ${cls}`} />;
}
