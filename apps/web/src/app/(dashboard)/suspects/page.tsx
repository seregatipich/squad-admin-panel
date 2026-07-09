import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/dal';
import { SuspectsBrowser } from './SuspectsBrowser';

export const dynamic = 'force-dynamic';

/**
 * Watchlist page: players who currently carry an active suspicion mark
 * (wallhack, aimbot, etc.), searchable and filterable by mark type and ban
 * status. Gated the same way the underlying `/api/v1/suspects` API gates
 * itself — `player:view` is only granted to roles with panel access.
 */
export default async function SuspectsPage() {
  const me = await requireSession();
  if (!me.permissions.includes('player:view')) {
    redirect('/dashboard');
  }
  return <SuspectsBrowser />;
}
