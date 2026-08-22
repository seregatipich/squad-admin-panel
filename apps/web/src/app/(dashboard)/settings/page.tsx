'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageHeader,
  Skeleton,
} from '@/components/ui';
import { NAV_GROUPS, type NavItem } from '@/lib/nav';

interface Me {
  permissions: string[];
}

/**
 * Колонки раздела «Настройки» ровно в том виде, в каком их показывает верхняя
 * панель. Дерево читается из `lib/nav.ts` и не копируется сюда: страница,
 * заведённая в меню, обязана появиться и на витрине без второй правки, иначе
 * два списка расходятся уже на третьей новой странице.
 */
const SETTINGS_COLUMNS: NavItem[] =
  NAV_GROUPS.find((group) => group.labelKey === 'nav.group.settings')?.items ?? [];

/**
 * Витрина раздела настроек.
 *
 * До неё адрес `/settings` не открывался ничем: два десятка страниц раздела
 * существовали только пунктами выпадающего меню, и попасть в них можно было
 * единственным способом — раскрыв меню и попав курсором в нужную строку.
 * Витрина даёт разделу собственный экран, а вложенным страницам — место,
 * куда возвращает `PageHeader backHref`.
 *
 * Права те же, что и у меню: `permission` у пункта — это ключ из
 * `GET /api/v1/me`, и страница, недоступная оператору, не показывается ни
 * здесь, ни в панели. Ни один пункт этого раздела не зависит от модуля
 * экономики, поэтому фильтр по `requiresEconomy` здесь не нужен.
 */
export default function SettingsIndexPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMe((await res.json()) as Me);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleColumns = me
    ? SETTINGS_COLUMNS.map((column) => ({
        label: column.label,
        pages: (column.children ?? []).filter(
          (page): page is NavItem & { href: string } =>
            page.href !== undefined &&
            (!page.permission || me.permissions.includes(page.permission)),
        ),
      })).filter((column) => column.pages.length > 0)
    : [];

  return (
    <>
      <PageHeader
        title="Настройки"
        subtitle="Панель, модерация, игровые правила, автоматика и интеграции."
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить список настроек"
          description={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {me === null ? (
        error ? null : (
          <Skeleton variant="card" count={4} label="Загрузка списка настроек" />
        )
      ) : (
        visibleColumns.map((column) => (
          <GroupedList key={column.label} title={column.label}>
            {column.pages.map((page) => (
              <GroupedRow
                key={page.href}
                href={page.href}
                label={page.label}
                description={page.hint}
              />
            ))}
          </GroupedList>
        ))
      )}
    </>
  );
}
