import { redirect } from 'next/navigation';
import { getSession } from '@/lib/dal';

export const dynamic = 'force-dynamic';

/**
 * Post-login entry point.
 *
 * VIPSUB-5 (#171) made a session possible for a player without `panel_access`,
 * so this can no longer send every cookie holder to `/dashboard` — that route's
 * layout renders the admin shell and every widget in it calls a panel-gated
 * route. Such a player goes to the self-service page instead.
 *
 * The panel check is the permission set itself: `derivePanelPermissions`
 * (`apps/api/src/lib/rbac.ts`) hands every non-gated catalogue key to anyone
 * with `panel_access`, so an empty set proves its absence. `GET /api/v1/me` is
 * frozen for this batch, hence no dedicated capability flag. A role that has
 * explicit `role_permissions` rows but no `panel_access` is a misconfiguration
 * the panel's own role editor does not produce, and it still cannot reach any
 * panel route.
 */
export default async function RootPage() {
  const me = await getSession();
  if (!me) redirect('/login');
  if (me.permissions.length === 0) redirect('/me');
  redirect('/dashboard');
}
