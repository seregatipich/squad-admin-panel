import { redirect } from 'next/navigation';
import { CommandPalette } from '@/components/CommandPalette';
import { ConnectionBanner } from '@/components/connection-banner';
import { ForcedLogout } from '@/components/ForcedLogout';
import { RoleExpiryToast } from '@/components/RoleExpiryToast';
import { SeedNotificationToast } from '@/components/SeedNotificationToast';
import { ServerBar } from '@/components/ServerBar';
import { TopNav } from '@/components/TopNav';
import { ToastRegion } from '@/components/ui/ToastRegion';
import { apiFetch } from '@/lib/api';
import { requireSession } from '@/lib/dal';
import { NAV_GROUPS } from '@/lib/nav';

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

  // #225: only the fetch is guarded. `redirect()` signals by throwing, so
  // calling it inside the `try` fed its own control-flow error to the `catch`
  // and an unfinished panel silently rendered the dashboard instead of going to
  // `/setup`. The `catch` keeps its original job — a setup-status outage must
  // not lock everyone out — so an unreachable endpoint still lets the user
  // through.
  let setupCompleted = true;
  try {
    setupCompleted = (await apiFetch<SetupStatus>('/api/v1/setup/status')).setup_completed;
  } catch {
    // if the endpoint fails, let the user through
  }
  if (!setupCompleted) redirect('/setup');

  // Navigation is a top bar, not a side column: the panel's work is wide
  // tables, and a sidebar would spend a fixed slice of every screen on links
  // that are read once per session.
  return (
    <div className="min-h-screen">
      <ForcedLogout />
      {/* Все всплывающие уведомления живут в одной области: раньше каждое
          прибивалось к правому нижнему углу само и накрывало соседнее. */}
      <ToastRegion>
        <ConnectionBanner />
        <SeedNotificationToast />
        <RoleExpiryToast />
      </ToastRegion>
      <TopNav
        permissions={me.permissions}
        displayName={me.canonical_name}
        groups={NAV_GROUPS}
        economyEnabled={me.economy_enabled ?? false}
      />
      <ServerBar />
      <CommandPalette permissions={me.permissions} economyEnabled={me.economy_enabled ?? false} />
      <main className="mx-auto w-full max-w-[1600px] space-y-6 px-6 py-6">{children}</main>
    </div>
  );
}
