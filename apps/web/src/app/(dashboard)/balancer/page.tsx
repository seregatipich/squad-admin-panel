import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/dal';
import { BalancerBrowser } from './BalancerBrowser';

export const dynamic = 'force-dynamic';

/**
 * `/balancer` — the GAME-2 (#81) team-balancer operator surface: dry-run
 * proposals pushed in by the upstream SquadJS exporter, plus the rules that
 * decide when a proposal counts as an imbalance.
 *
 * This page is review and configuration only. Nothing on it can move a player
 * on a live server; execute mode is a separate, separately approved change.
 *
 * The server-side `balancer:view` gate is the real one — the sidebar's
 * permission filter is cosmetic and must not be relied on.
 */
export default async function BalancerPage() {
  const me = await requireSession();
  if (!me.permissions.includes('balancer:view')) {
    redirect('/dashboard');
  }

  return <BalancerBrowser canEdit={me.permissions.includes('balancer:edit')} />;
}
