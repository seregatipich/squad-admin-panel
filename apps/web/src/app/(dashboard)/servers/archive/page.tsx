'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';

interface ArchiveRow {
  id: string;
  display_name: string;
  slug: string;
  deleted_at: string;
  deleted_by_steam_id64: string | null;
  deletion_backup_marker_id: string | null;
}

interface ArchiveResponse {
  items: ArchiveRow[];
  total: number;
}

interface Me {
  permissions: string[];
}

export default function ArchivePage() {
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  /**
   * Признак «этот ответ уже никому не нужен» приходит параметром, а не живёт
   * в замыкании эффекта: тот же запрос запускает и кнопка «Повторить», у
   * которой отменять нечего.
   */
  const loadArchive = useCallback(async (isStale: () => boolean = () => false) => {
    try {
      const m = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
      if (m.ok) {
        const meBody = (await m.json()) as Me;
        if (!meBody.permissions.includes('server:view')) {
          if (!isStale()) setForbidden(true);
          return;
        }
      }
      const r = await fetch('/api/v1/servers/archive', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (r.status === 403) {
        if (!isStale()) setForbidden(true);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ArchiveResponse;
      if (!isStale()) {
        setData(j);
        setErr(null);
      }
    } catch (e) {
      if (!isStale()) setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadArchive(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadArchive]);

  return (
    <PageContainer>
      <PageHeader
        title="Архив серверов"
        backHref="/servers"
        backLabel="К списку серверов"
        meta={data ? <span>Записей: {data.total}</span> : undefined}
      />

      {forbidden ? (
        <InlineBanner
          tone="crit"
          title="Доступ запрещён"
          description={
            <>
              Требуется право <code className="font-mono">server:view</code>.
            </>
          }
        />
      ) : (
        <>
          {err && (
            <InlineBanner
              tone="crit"
              title="Не удалось получить архив"
              description={err}
              action={
                <Button
                  onClick={() => {
                    void loadArchive();
                  }}
                >
                  Повторить
                </Button>
              }
            />
          )}

          {!data && !err ? (
            <SkeletonTable rows={5} cols={6} label="Загружается архив серверов" />
          ) : data && data.items.length === 0 ? (
            <Card>
              <EmptyState
                title="Архив пуст"
                description="Удалённые серверы попадают сюда, и отсюда же их можно восстановить."
              />
            </Card>
          ) : data ? (
            <Card padding="none">
              <Table ariaLabel="Удалённые серверы">
                <TableHead>
                  <tr>
                    <Th>Имя</Th>
                    <Th>Идентификатор</Th>
                    <Th>Удалён</Th>
                    <Th>Кто удалил</Th>
                    <Th>Бэкап</Th>
                    <Th align="right">Действия</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {data.items.map((row) => (
                    <TableRow key={row.id} interactive>
                      <Td>
                        <Link
                          href={`/servers/archive/${row.id}`}
                          className="font-medium text-accent no-underline"
                        >
                          {row.display_name}
                        </Link>
                        <div className="font-mono text-2xs text-ink-3">{row.id}</div>
                      </Td>
                      <Td className="font-mono text-xs">{row.slug}</Td>
                      <Td>
                        <span title={new Date(row.deleted_at).toLocaleString()}>
                          {formatRelative(row.deleted_at)}
                        </span>
                      </Td>
                      <Td className="font-mono text-xs">{row.deleted_by_steam_id64 ?? '—'}</Td>
                      <Td>{row.deletion_backup_marker_id ? 'есть' : '—'}</Td>
                      <Td align="right">
                        {/* Действие видно всегда: показ по наведению недостижим
                            ни с клавиатуры, ни с сенсорного экрана. */}
                        <ButtonLink href={`/servers/archive/${row.id}/restore`} size="sm">
                          Восстановить
                        </ButtonLink>
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ) : null}
        </>
      )}
    </PageContainer>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}с назад`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}м назад`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}ч назад`;
  return `${Math.floor(diffSec / 86400)}д назад`;
}
