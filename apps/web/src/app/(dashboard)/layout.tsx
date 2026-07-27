import { redirect } from 'next/navigation';
import { CommandPalette } from '@/components/CommandPalette';
import { ConnectionBanner } from '@/components/connection-banner';
import { ForcedLogout } from '@/components/ForcedLogout';
import { RoleExpiryToast } from '@/components/RoleExpiryToast';
import { SeedNotificationToast } from '@/components/SeedNotificationToast';
import { SidebarNav } from '@/components/SidebarNav';
import { apiFetch } from '@/lib/api';
import { requireSession } from '@/lib/dal';

interface SetupStatus {
  setup_completed: boolean;
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const me = await requireSession();

  // VIPSUB-5 (#171) made a session possible for a player without
  // `panel_access`, and `GET /api/v1/me` is `selfService`, so `requireSession()`
  // now succeeds for one. `/` already routes such a player to `/me`
  // (`apps/web/src/app/page.tsx`), but that only covers the post-login hop —
  // reaching a `(dashboard)` URL directly would otherwise render this shell
  // around content every panel-gated route answers 401 for. Same panel check as
  // the root page: `derivePanelPermissions` (`apps/api/src/lib/rbac.ts`) grants
  // the whole non-gated catalogue to anyone with `panel_access`, so an empty set
  // proves its absence.
  //
  // Deliberately outside the try/catch below: `redirect()` aborts by throwing,
  // and that bare `catch` would swallow it.
  if (me.permissions.length === 0) redirect('/me');

  try {
    const status = await apiFetch<SetupStatus>('/api/v1/setup/status');
    if (!status.setup_completed) redirect('/setup');
  } catch {
    // if the endpoint fails, let the user through
  }

  return (
    <div className="flex min-h-screen flex-col">
      <ConnectionBanner />
      <ForcedLogout />
      <SeedNotificationToast />
      <RoleExpiryToast />
      <div className="flex flex-1">
        <SidebarNav
          permissions={me.permissions}
          displayName={me.canonical_name}
          economyEnabled={me.economy_enabled ?? false}
        />
        <CommandPalette permissions={me.permissions} economyEnabled={me.economy_enabled ?? false} />
        <main className="flex-1 space-y-6 p-8">{children}</main>
      </div>
    </div>
  );
}
