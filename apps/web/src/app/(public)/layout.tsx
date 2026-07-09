/**
 * Layout for anonymous, no-session public pages (e.g. the public stats
 * portal). Deliberately minimal: no `SidebarNav`, no `requireSession()`
 * call, and no dependency on `/api/v1/setup/status` — this route group
 * must render without any authentication state.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
