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
