import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/dal';
import { UsersBrowser } from './UsersBrowser';

export const dynamic = 'force-dynamic';

/**
 * `/users` — panel-role registry, editable (assign/unassign) with
 * `user:manage_roles`. Gated the same way `/vips` and `/suspects` gate
 * themselves: `user:view` mirrors `GET /api/v1/users`'s own permission
 * requirement (finding #740), instead of relying on the client fetch's 403
 * to silently leave the page on its loading skeleton forever.
 */
export default async function UsersPage() {
  const me = await requireSession();
  if (!me.permissions.includes('user:view')) {
    redirect('/dashboard');
  }
  return <UsersBrowser />;
}
