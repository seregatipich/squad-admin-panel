'use client';
import Link from 'next/link';
import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  formatAbsolute,
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
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { ApiError } from '@/lib/api';
import { useApiResource } from '@/lib/use-polled-resource';

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

export default function ArchivePage() {
  const locale = useIntlLocale();
  const archive = useApiResource<ArchiveResponse>('/api/v1/servers/archive');
  const data = archive.data ?? null;
  const forbidden = archive.error instanceof ApiError && archive.error.status === 403;
  const err = forbidden ? null : archive.errorMessage;

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
                    void archive.refresh();
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
                        <span title={formatAbsolute(row.deleted_at, locale) ?? ''}>
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
