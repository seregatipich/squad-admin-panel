import Link from 'next/link';
import { playerLabel } from './helpers';

export function PlayerRef({
  id,
  name,
  fallbackRaw,
}: {
  id: string | null;
  name: string | null;
  fallbackRaw?: string | null;
}) {
  if (id) {
    return (
      <Link href={`/all-players/${id}`} className="text-accent no-underline hover:brightness-110">
        {playerLabel(id, name)}
      </Link>
    );
  }
  return <span className="text-ink-2">{playerLabel(id, name, fallbackRaw ?? null)}</span>;
}
