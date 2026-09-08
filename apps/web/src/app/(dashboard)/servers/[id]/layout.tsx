'use client';

import { usePathname } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import {
  Badge,
  PageContainer,
  PageHeader,
  SegmentedNav,
  type SegmentedNavItem,
} from '@/components/ui';

/**
 * Подразделы сервера слева направо: сначала то, на что оператор смотрит во
 * время матча, затем настройки и служебные журналы. `path` дописывается к
 * `/servers/<id>`, поэтому у обзора он пустой.
 *
 * `/combat-log` попал сюда вместе с остальными: маршрут существовал и раньше,
 * но ссылки на него не было ни в одном месте панели.
 */
const SECTIONS: ReadonlyArray<{ path: string; label: string }> = [
  { path: '', label: 'Обзор' },
  { path: '/configs', label: 'Конфиги' },
  { path: '/rotation', label: 'Ротация' },
  { path: '/rotation-calendar', label: 'Календарь ротации' },
  { path: '/map-vote', label: 'Голосование за карту' },
  { path: '/schedule', label: 'Планировщик' },
  { path: '/events', label: 'События' },
  { path: '/combat-log', label: 'Боевой лог' },
  { path: '/monitoring', label: 'Мониторинг' },
  { path: '/settings', label: 'Настройки' },
];

/**
 * Подразделы, которые есть только у сервера, размещённого на хосте панели:
 * файлы конфигов, ротация (пишет LayerRotation.cfg) и метрики контейнера.
 * У внешнего сервера (runtime=external) нет ни файлов, ни контейнера — API
 * отвечает на эти маршруты 409, поэтому вкладки не показываются вовсе.
 */
const CONTAINER_ONLY_PATHS = new Set([
  '/configs',
  '/rotation',
  '/rotation-calendar',
  '/monitoring',
]);

/** Пока имя не пришло, заголовок не должен быть пустым. */
const FALLBACK_TITLE = 'Сервер';

interface ServerNameResponse {
  server: { display_name: string; runtime?: string };
}

/**
 * Каркас раздела «Сервер»: имя сервера и переключатель подразделов.
 *
 * **`<h1>` страницы принадлежит этому файлу.** Имя сервера — единственный
 * заголовок первого уровня во всём разделе, поэтому ни `page.tsx`, ни любая
 * подстраница (`configs`, `rotation`, `monitoring`, …) собственный `<h1>` и
 * собственный `PageHeader` не рендерят: у них остаются только заголовки
 * разделов внутри содержимого. Второй `<h1>` на странице лишает экранный
 * диктор единственной опоры, по которой оператор понимает, где он оказался.
 *
 * Ряд ссылок со стрелками («Конфиги →», «Ротация →», …) заменён на
 * `SegmentedNav`: он отмечает текущий подраздел `aria-current="page"` (через
 * `isSegmentActive` — совпадение по точному адресу или по префиксу, дописанному
 * `/`), поэтому с любой подстраницы виден и путь назад, и место, где оператор
 * сейчас находится.
 *
 * Имя запрашивается тем же `GET /api/v1/servers/:id`, которым живёт обзор, —
 * один раз на вход в раздел: подстраницам, кроме обзора, сервер целиком не
 * нужен, а заголовок нужен всем.
 */
export default function ServerSectionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const pathname = usePathname();
  const [name, setName] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/servers/${id}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as ServerNameResponse;
        if (!cancelled) {
          setName(body.server.display_name);
          setRuntime(body.server.runtime ?? 'container');
        }
      } catch {
        // Имя — украшение шапки: содержимое подраздела грузится независимо и
        // само сообщит об ошибке запроса.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const isExternal = runtime === 'external';
  const items: SegmentedNavItem[] = SECTIONS.filter(
    (section) => !isExternal || !CONTAINER_ONLY_PATHS.has(section.path),
  ).map((section) => ({
    href: `/servers/${id}${section.path}`,
    label: section.label,
  }));

  // Ширину держит раздел, а не страница: заголовок и вкладки живут здесь, и
  // если бы ширину выбирала подстраница, шапка раздела и его содержимое
  // расходились бы по левому краю (§3).
  return (
    <PageContainer width="wide">
      <div className="space-y-2">
        <PageHeader
          title={name ?? FALLBACK_TITLE}
          backHref="/servers"
          backLabel="Все серверы"
          meta={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{id}</span>
              {isExternal ? (
                <Badge tone="accent" size="sm" title="Размещён вне панели; управление через RCON">
                  внешний
                </Badge>
              ) : null}
            </span>
          }
        />
        <SegmentedNav items={items} pathname={pathname} ariaLabel="Разделы сервера" />
      </div>
      {children}
    </PageContainer>
  );
}
