'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { logout } from '@/components/LogoutButton';
import { SearchIcon } from '@/components/ui/icons';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { useTranslator } from '@/i18n/LocaleProvider';
import type { Translator } from '@/i18n/translate';
import { openCommandPalette } from '@/lib/commandPalette';
import { activeNavGroupLabel, isNavHrefActive, type NavGroup, type NavItem } from '@/lib/nav';
import { fitNavEntries } from '@/lib/nav-overflow';
import { useLiveSubscription } from '@/lib/use-live-bus';

/** Filters an item's own gates, and — for a menu column — its children's too. */
function visibleFor(item: NavItem, permissions: string[], economyEnabled: boolean): NavItem | null {
  const allowed =
    (!item.permission || permissions.includes(item.permission)) &&
    (!item.requiresEconomy || economyEnabled);
  if (!allowed) return null;
  if (!item.children) return item;
  const children = item.children
    .map((child) => visibleFor(child, permissions, economyEnabled))
    .filter((child): child is NavItem => child !== null);
  return children.length > 0 ? { ...item, children } : null;
}

/**
 * Number of reports still awaiting moderation. Fetched once on mount and
 * refreshed whenever a `report.created`/`report.updated` live-bus event
 * arrives, so the badge tracks the queue without polling.
 */
function usePendingReportsCount(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    fetch('/api/v1/reports?status=pending&page=1&page_size=1', {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { total?: number } | null) => setCount(data?.total ?? 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useLiveSubscription('report.created', refresh);
  useLiveSubscription('report.updated', refresh);

  return count;
}

/** Whether any page inside `group` carries the pending-reports badge. */
function groupShowsPendingReports(group: NavGroup): boolean {
  return group.items.some(
    (item) => item.showsPendingReports || item.children?.some((c) => c.showsPendingReports),
  );
}

function PendingBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      title={label}
      className="rounded-full bg-warn px-1.5 py-px font-mono text-2xs font-semibold leading-none text-bg"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Context every nav item needs to become a menu item. */
interface ItemContext {
  pathname: string;
  pendingReports: number;
  t: Translator;
}

function toMenuLink(item: NavItem, ctx: ItemContext): MenuItem {
  const label = item.labelKey ? ctx.t(item.labelKey) : item.label;
  return {
    kind: 'link',
    href: item.href ?? '#',
    label,
    hint: item.hintKey ? ctx.t(item.hintKey) : undefined,
    active: isNavHrefActive(ctx.pathname, item.href),
    badge:
      item.showsPendingReports && ctx.pendingReports > 0 ? (
        <PendingBadge
          count={ctx.pendingReports}
          label={ctx.t('nav.pendingReports', { count: ctx.pendingReports })}
        />
      ) : undefined,
  };
}

/** A nav item is either a page (one menu item) or a column of pages (a group). */
function toMenuItems(items: NavItem[], ctx: ItemContext): MenuItem[] {
  return items.map((item) =>
    item.children
      ? {
          kind: 'group' as const,
          label: item.labelKey ? ctx.t(item.labelKey) : item.label,
          items: item.children.map((child) => toMenuLink(child, ctx)),
        }
      : toMenuLink(item, ctx),
  );
}

/**
 * Сколько пунктов панели помещается в её ширину.
 *
 * Ширины пунктов кэшируются при первом полном рендере и переиспользуются: как
 * только часть пунктов уезжает в «Ещё», измерить их в полосе уже нельзя.
 * Меняются они только вместе с языком, а смена языка перерисовывает панель
 * целиком, так что кэш живёт ровно столько, сколько подписи.
 *
 * @param count Сколько всего пунктов в панели.
 * @returns Ссылки на полосу и кнопку «Ещё» плюс число помещающихся пунктов.
 */
function useNavOverflow(count: number, measureKey: string) {
  const rowRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLLIElement>(null);
  const widthsRef = useRef<number[]>([]);
  const [visibleCount, setVisibleCount] = useState(count);
  // Замер идёт в два кадра. В фазе `measure` в полосе стоят все пункты — только
  // так видно их настоящую ширину: то, что уехало в «Ещё», измерить негде.
  // Фаза возвращается каждый раз, когда содержимое пунктов меняется, иначе
  // кэш устаревает — счётчик жалоб прилетает с задержкой и делает «Инструменты»
  // на два десятка пикселей шире уже после того, как ширины сняты.
  const [phase, setPhase] = useState<'measure' | 'settled'>('measure');

  // biome-ignore lint/correctness/useExhaustiveDependencies: measureKey — и есть описание содержимого, от которого зависят ширины
  useLayoutEffect(() => {
    widthsRef.current = [];
    setVisibleCount(count);
    setPhase('measure');
  }, [measureKey, count]);

  // Слой вёрстки, а не эффект после отрисовки: иначе на узком окне панель
  // успевает мигнуть развёрнутой.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    const fitFromCache = () => {
      if (widthsRef.current.length !== count) return;
      const more = moreRef.current;
      const moreWidth = more && more.offsetWidth > 0 ? more.offsetWidth + GAP_PX : MORE_FALLBACK_PX;
      setVisibleCount(fitNavEntries(widthsRef.current, row.clientWidth, moreWidth));
    };

    if (phase === 'measure') {
      const items = [...row.children].filter((el) => el !== moreRef.current);
      if (items.length !== count) return;
      widthsRef.current = items.map((el) => (el as HTMLElement).offsetWidth + GAP_PX);
      fitFromCache();
      setPhase('settled');
      return;
    }

    fitFromCache();
    // Ширина окна меняет только доступное место, но не сами пункты, поэтому
    // здесь достаточно пересчёта по кэшу.
    const observer = new ResizeObserver(fitFromCache);
    observer.observe(row);
    return () => observer.disconnect();
  }, [count, phase]);

  return { rowRef, moreRef, visibleCount };
}

/** Ключ состояния открытого меню для кнопки «Ещё». */
const OVERFLOW_KEY = '\u0000overflow';

/** Зазор между пунктами (`gap-0.5`), который измерение обязано учесть. */
const GAP_PX = 2;

/** Ширина кнопки «Ещё» до того, как она впервые отрисована. */
const MORE_FALLBACK_PX = 64;

/** Один пункт полосы: прямая ссылка или меню раздела. */
type BarEntry =
  | { kind: 'link'; key: string; item: NavItem }
  | { kind: 'menu'; key: string; label: string; groupLabel: string; items: NavItem[] };

/** Разворачивает колонки мега-меню в плоский список страниц. */
function flattenEntryPages(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => item.children ?? [item]);
}

/**
 * Пункты, не поместившиеся в полосу, — как содержимое меню «Ещё».
 *
 * Каждый уехавший раздел становится секцией со своим именем, поэтому в меню
 * видно, откуда пункт, а колонки мега-меню разворачиваются в один список:
 * внутри и без того вложенного меню вторая вложенность только мешает.
 */
function toOverflowItems(entries: BarEntry[], ctx: ItemContext): MenuItem[] {
  return entries.map((entry) =>
    entry.kind === 'link'
      ? toMenuLink(entry.item, ctx)
      : {
          kind: 'group' as const,
          label: entry.label,
          items: flattenEntryPages(entry.items).map((item) => toMenuLink(item, ctx)),
        },
  );
}

/**
 * The panel's global navigation: a sticky top bar with dropdown menus.
 *
 * There is no left sidebar. A sidebar spends a fixed column of every screen on
 * links that are read once per session; on a panel whose main job is wide
 * tables of players, matches and log lines, that column is the most expensive
 * real estate in the app. The same tree fits in a 46px bar and every page gets
 * the full window width.
 *
 * Menus are {@link Menu}, so each one is a real `role="menu"`: arrow keys walk
 * it, Home/End jump to its ends, a typed letter finds an item, Escape closes it
 * and returns focus to the trigger. They open on click rather than hover, so a
 * pointer crossing the bar on its way somewhere else never covers the page.
 */
export function TopNav({
  permissions,
  displayName,
  groups,
  economyEnabled = false,
}: {
  permissions: string[];
  displayName: string;
  /** Navigation tree; defaults to the panel's own {@link NAV_GROUPS}. */
  groups: NavGroup[];
  /** ECON-5 (#165): items with `requiresEconomy` are hidden while false. */
  economyEnabled?: boolean;
}) {
  const pathname = usePathname() ?? '';
  const pendingReports = usePendingReportsCount();
  const t = useTranslator();
  const [open, setOpen] = useState<string | null>(null);
  const [lastPath, setLastPath] = useState(pathname);
  const activeGroup = activeNavGroupLabel(pathname, groups);
  const ctx: ItemContext = { pathname, pendingReports, t };

  // Navigating closes whatever menu was open. Adjusted during render rather
  // than in an effect, so the menu never paints once on the new page.
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(null);
  }

  // Полоса строится из данных, а не отрисовывается на месте: чтобы решить, что
  // не помещается, нужен список пунктов до того, как хоть один из них отрисован.
  const entries: BarEntry[] = groups.flatMap<BarEntry>((group, groupIndex) => {
    const visible = group.items
      .map((item) => visibleFor(item, permissions, economyEnabled))
      .filter((item): item is NavItem => item !== null);
    if (visible.length === 0) return [];

    // У безымянной группы своего меню нет — её пункты стоят в полосе прямыми
    // ссылками (сегодня такая одна, «Дашборд»).
    if (!group.label) {
      return visible.map((item) => ({ kind: 'link' as const, key: item.href ?? '', item }));
    }
    return [
      {
        kind: 'menu' as const,
        key: group.label ?? `group-${groupIndex}`,
        label: group.labelKey ? t(group.labelKey) : group.label,
        groupLabel: group.label,
        items: visible,
      },
    ];
  });

  // Ключ описывает всё, от чего зависят ширины пунктов: их набор, язык
  // подписей и наличие счётчика, который приезжает отдельным запросом.
  const measureKey = `${entries.map((e) => e.key).join('|')}|${t('nav.more')}|${pendingReports > 0}`;
  const { rowRef, moreRef, visibleCount } = useNavOverflow(entries.length, measureKey);
  const inBar = entries.slice(0, visibleCount);
  const overflowed = entries.slice(visibleCount);
  const overflowHasBadge =
    pendingReports > 0 &&
    overflowed.some(
      (entry) =>
        entry.kind === 'menu' &&
        groupShowsPendingReports({ label: entry.groupLabel, items: entry.items }),
    );
  const overflowHasActive = overflowed.some(
    (entry) =>
      (entry.kind === 'menu' && activeGroup === entry.groupLabel) ||
      (entry.kind === 'link' && isNavHrefActive(pathname, entry.item.href)),
  );

  return (
    <nav
      aria-label={t('nav.mainNav')}
      className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl"
    >
      <div className="flex h-[46px] items-center gap-1 px-3">
        {/* Прокрутки здесь нет намеренно: пункт, уехавший за край, недостижим,
            и единственным намёком на него служила полоска прокрутки. Всё, что
            не поместилось, уходит в меню «Ещё» ниже. */}
        <ul ref={rowRef} className="flex min-w-0 flex-1 items-center gap-0.5">
          {inBar.map((entry) =>
            entry.kind === 'link' ? (
              <li key={entry.key}>
                <Link
                  href={entry.item.href ?? '#'}
                  aria-current={isNavHrefActive(pathname, entry.item.href) ? 'page' : undefined}
                  className={`flex h-8 items-center whitespace-nowrap rounded-ctl px-2.5 text-xs no-underline transition-colors duration-150 ${
                    isNavHrefActive(pathname, entry.item.href)
                      ? 'bg-raised text-ink'
                      : 'text-ink-2 hover:bg-raised/60 hover:text-ink'
                  }`}
                >
                  {entry.item.labelKey ? t(entry.item.labelKey) : entry.item.label}
                </Link>
              </li>
            ) : (
              <li key={entry.key}>
                <Menu
                  trigger={{
                    label: entry.label,
                    active: activeGroup === entry.groupLabel,
                    badge:
                      open !== entry.groupLabel &&
                      pendingReports > 0 &&
                      groupShowsPendingReports({ label: entry.groupLabel, items: entry.items }) ? (
                        <PendingBadge
                          count={pendingReports}
                          label={t('nav.pendingReports', { count: pendingReports })}
                        />
                      ) : undefined,
                  }}
                  items={toMenuItems(entry.items, ctx)}
                  open={open === entry.groupLabel}
                  onOpenChange={(next) => setOpen(next ? entry.groupLabel : null)}
                  columns={entry.items.filter((item) => item.children).length > 1 ? 2 : 1}
                />
              </li>
            ),
          )}

          {/* Кнопка остаётся в разметке и когда пуста: измерение опирается на
              её ширину, а исчезающая кнопка меняла бы ширину полосы и гоняла
              раскладку туда-обратно на граничных размерах окна. */}
          <li
            ref={moreRef}
            className={overflowed.length === 0 ? 'invisible w-0 overflow-hidden' : ''}
          >
            <Menu
              align="end"
              trigger={{
                label: t('nav.more'),
                active: overflowHasActive,
                badge: overflowHasBadge ? (
                  <PendingBadge
                    count={pendingReports}
                    label={t('nav.pendingReports', { count: pendingReports })}
                  />
                ) : undefined,
              }}
              items={toOverflowItems(overflowed, ctx)}
              open={open === OVERFLOW_KEY}
              onOpenChange={(next) => setOpen(next ? OVERFLOW_KEY : null)}
              columns={overflowed.length > 2 ? 2 : 1}
            />
          </li>
        </ul>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex h-8 w-[220px] items-center gap-2 rounded-ctl border border-line-2 bg-bg px-2 text-xs text-ink-3 transition-colors duration-150 hover:border-ink-3 max-lg:w-9 max-lg:justify-center"
          >
            <SearchIcon className="size-3.5" />
            <span className="max-lg:hidden">{t('nav.search')}</span>
            <kbd className="ml-auto rounded border border-line-2 px-1 font-mono text-2xs max-lg:hidden">
              ⌘K
            </kbd>
          </button>

          <UserMenu displayName={displayName} t={t} />
        </div>
      </div>
    </nav>
  );
}

function UserMenu({ displayName, t }: { displayName: string; t: Translator }) {
  const [open, setOpen] = useState(false);

  return (
    <Menu
      align="end"
      open={open}
      onOpenChange={setOpen}
      trigger={{
        ariaLabel: t('nav.userMenu'),
        label: (
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid size-[18px] place-items-center rounded-full bg-raised text-2xs"
            >
              {displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="max-sm:hidden">{displayName}</span>
          </span>
        ),
      }}
      items={[
        { kind: 'link', href: '/settings/account', label: t('nav.account') },
        { kind: 'link', href: '/settings/tokens', label: t('nav.tokens') },
        { kind: 'separator' },
        { kind: 'action', label: t('nav.logout'), onSelect: () => void logout() },
      ]}
    />
  );
}
