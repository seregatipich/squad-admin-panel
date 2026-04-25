import type { RoleColor } from '@squad/shared-config';

const CLASS_MAP: Record<RoleColor, string> = {
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

export function RoleColorDot({ color, size = 'md' }: { color: RoleColor; size?: 'sm' | 'md' }) {
  const cls = CLASS_MAP[color] ?? 'bg-neutral-500';
  const dim = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';
  return <span className={`inline-block rounded-full ${dim} ${cls}`} aria-hidden />;
}
