import { requireSession } from '@/lib/dal';
import { MeBrowser } from './MeBrowser';

export const dynamic = 'force-dynamic';

/**
 * VIPSUB-5 (#171) self-service VIP page. Lives in the `(me)` route group, whose
 * layout requires a session but no panel access — this is the only page a
 * player without `panel_access` can reach.
 */
export default async function MePage() {
  const me = await requireSession();
  return <MeBrowser displayName={me.canonical_name} />;
}
