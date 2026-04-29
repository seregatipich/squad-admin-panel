import { ConnectionBanner } from '@/components/connection-banner';
import { SidebarNav } from '@/components/SidebarNav';
import { requireSession } from '@/lib/dal';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const me = await requireSession();
  return (
    <div className="flex min-h-screen flex-col">
      <ConnectionBanner />
      <div className="flex flex-1">
        <SidebarNav permissions={me.permissions} displayName={me.canonical_name} />
        <main className="flex-1 space-y-6 p-8">{children}</main>
      </div>
    </div>
  );
}
