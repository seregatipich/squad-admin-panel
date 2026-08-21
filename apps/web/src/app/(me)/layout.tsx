import { LogoutButton } from '@/components/LogoutButton';
import { requireSession } from '@/lib/dal';

/**
 * Layout for the VIPSUB-5 (#171) self-service tier: a real session is required,
 * but panel access is NOT. Deliberately renders no `TopNav`, no
 * `CommandPalette` and no live-bus widgets — every one of those calls a
 * panel-gated route that a `self_service` session cannot reach, and the whole
 * point of this group is that a plain VIP can use it.
 *
 * Distinct from `(dashboard)` (which requires the panel shell) and from
 * `(public)` (which has no session at all).
 */
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const me = await requireSession();

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-sm uppercase tracking-widest text-neutral-500">Личный кабинет</span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-400">{me.canonical_name}</span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>
    </div>
  );
}
