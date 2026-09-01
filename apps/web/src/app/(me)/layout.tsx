import { GlobalLogoutButton, LogoutButton } from '@/components/LogoutButton';
import { getBssSiteUrl } from '@/lib/bss-site';
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
 *
 * Оболочка повторяет каркас панели: та же верхняя полоса 46px, те же
 * поверхности и те же вертикальные поля страницы. Ширину содержимого выбирает
 * сама страница через `PageContainer`, здесь задан только внешний предел и
 * поля — иначе на одно приложение пришлось бы два разных ритма.
 */
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const me = await requireSession();
  const siteUrl = getBssSiteUrl();

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="flex min-h-[46px] items-center border-b border-line bg-surface/80 px-3 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-2 py-1">
          <span className="text-[13px] font-semibold text-ink">Личный кабинет</span>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            <span className="max-w-32 truncate px-2 text-xs text-ink-3">{me.canonical_name}</span>
            <a
              href={siteUrl}
              className="inline-flex min-h-11 items-center px-2 text-xs text-ink-2 no-underline transition-colors hover:text-ink"
            >
              Перейти на bss.games
            </a>
            <LogoutButton />
            <GlobalLogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] space-y-6 px-6 py-6">{children}</main>
    </div>
  );
}
