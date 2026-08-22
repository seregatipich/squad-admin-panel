import Link from 'next/link';
import type { ReactNode } from 'react';

export type SegmentedNavItem = {
  href: string;
  label: ReactNode;
  badge?: ReactNode;
};

/**
 * Принадлежит ли текущий адрес подразделу `href`.
 *
 * Совпадение либо точное, либо по префиксу, обязательно завершённому `/`:
 * без слэша `/servers/12` считался бы вложенным в `/servers/1`, и активными
 * подсвечивались бы сразу два сегмента.
 *
 * @param pathname Текущий путь без строки запроса.
 * @param href Адрес сегмента.
 * @returns `true`, если сегмент описывает текущую страницу или её родителя.
 */
export function isSegmentActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Сегментированная навигация по подразделам раздела — замена россыпи ссылок
 * со стрелками (§12 дизайн-системы).
 *
 * Это настоящие ссылки: страница подраздела открывается по адресу, работает
 * средняя кнопка мыши и «открыть в новой вкладке». Текущий путь приходит
 * пропсом, а не из `usePathname`, поэтому компонент остаётся серверным и
 * проверяемым без маршрутизатора.
 *
 * Пометку получает сегмент с самым длинным совпавшим адресом: иначе индексный
 * подраздел (`/servers/1`) дублировал бы `aria-current` у каждой вложенной
 * страницы (`/servers/1/players`), а таких пометок в навигации должна быть одна.
 *
 * @param items Подразделы слева направо.
 * @param pathname Текущий путь; сегмент, которому он принадлежит, помечается `aria-current`.
 * @param ariaLabel Название группы ссылок для скринридера.
 */
export function SegmentedNav({
  items,
  pathname,
  ariaLabel,
}: {
  items: SegmentedNavItem[];
  pathname: string;
  ariaLabel: string;
}) {
  const activeHref = items.reduce<string | undefined>((longest, item) => {
    if (!isSegmentActive(pathname, item.href)) return longest;
    return longest === undefined || item.href.length > longest.length ? item.href : longest;
  }, undefined);

  return (
    // Ряд прокручивается, когда подразделов больше, чем ширины: внутренний
    // отступ оставляет место кольцу фокуса (2px обводки + 2px отступа), иначе
    // `overflow-x-auto` срезал бы его у крайних ссылок.
    <nav aria-label={ariaLabel} className="overflow-x-auto p-1">
      <ul className="inline-flex w-max gap-0.5 rounded-ctl bg-raised p-0.5">
        {items.map((item) => {
          const active = item.href === activeHref;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-ctl px-3 text-xs font-medium no-underline transition-colors ${
                  active ? 'bg-surface text-ink' : 'text-ink-3 hover:text-ink'
                }`}
              >
                {item.label}
                {item.badge !== undefined && item.badge !== null && <span>{item.badge}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
