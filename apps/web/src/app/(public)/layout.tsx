/**
 * Layout for anonymous, no-session public pages (e.g. the public stats
 * portal). Deliberately minimal: no `TopNav`, no `requireSession()`
 * call, and no dependency on `/api/v1/setup/status` — this route group
 * must render without any authentication state.
 *
 * Вертикальные поля страницы задаёт этот `<main>` и только он: страницы группы
 * выбирают лишь ширину содержимого через `PageContainer`.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <main className="mx-auto w-full max-w-[1600px] space-y-6 px-6 py-6">{children}</main>
    </div>
  );
}
