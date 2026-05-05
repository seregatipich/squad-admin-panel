'use client';

interface Props {
  crashLoop: boolean;
  crashCount: number;
}

export function CrashBadge({ crashLoop, crashCount }: Props) {
  if (crashCount === 0 && !crashLoop) return null;

  if (crashLoop) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-red-900 px-1.5 py-0.5 text-xs font-medium text-red-200 animate-pulse">
        Цикл аварий
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-900 px-1.5 py-0.5 text-xs font-medium text-amber-200">
      {crashCount} {crashCount === 1 ? 'авария' : 'аварий'}
    </span>
  );
}
