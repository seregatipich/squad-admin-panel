'use client';
import { useMemo } from 'react';
import { BackupTriggerButton } from '@/components/BackupTriggerButton';
import { RestoreSnapshotButton } from '@/components/RestoreSnapshotButton';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  InlineBanner,
  PageHeader,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useApiResource } from '@/lib/use-polled-resource';

const POLL_MS = 30_000;

interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  paths: string[];
  tags: string[];
}

interface BackupList {
  snapshots: Snapshot[];
}

type Load =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error'; text: string }
  | { kind: 'ready'; snapshots: Snapshot[] };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU');
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function describeLoadFailure(error: Error): string {
  if (error instanceof ApiError) {
    return error.jsonBody<{ detail?: string }>()?.detail ?? `HTTP ${error.status}`;
  }
  return error.message;
}

export default function BackupPage() {
  // A 403 stops the poll (every later tick would repeat it); a hidden tab has
  // nobody to show the list to, so the bridge is not hit for it either (#675).
  const { data, error, refresh } = useApiResource<BackupList>('/api/v1/host/backups', {
    intervalMs: POLL_MS,
    pauseWhenHidden: true,
    stopPolling: isForbidden,
  });

  const state = useMemo<Load>(() => {
    if (isForbidden(error)) return { kind: 'forbidden' };
    // A failed background refresh keeps the last good list (#675).
    if (data) {
      // The bridge/restic contract for a taggless snapshot plausibly omits
      // `tags` or sends null; normalize so `.length`/`.map` never throws.
      return {
        kind: 'ready',
        snapshots: data.snapshots.map((s) => ({ ...s, tags: s.tags ?? [] })),
      };
    }
    if (error) return { kind: 'error', text: describeLoadFailure(error) };
    return { kind: 'loading' };
  }, [data, error]);

  return (
    <>
      <PageHeader
        title="Бэкапы"
        subtitle="Резервные копии Postgres и Redis снимаются восстановимыми логическими дампами (pg_dump + RDB) и хранятся в зашифрованном restic-репозитории. Ежедневный снимок делается по расписанию; здесь можно снять внеочередной бэкап или восстановить панель из выбранного снимка."
        actions={
          <BackupTriggerButton
            disabled={state.kind === 'forbidden'}
            disabledReason="Нет прав на управление хостом"
            onBackedUp={() => void refresh()}
          />
        }
      />

      {state.kind === 'forbidden' ? (
        <InlineBanner
          tone="warn"
          title="Недостаточно прав"
          description="Для просмотра и управления бэкапами нужно разрешение управления хост-демоном (host:manage)."
        />
      ) : null}

      {state.kind === 'error' ? (
        <InlineBanner
          tone="crit"
          title={`Не удалось загрузить список бэкапов: ${state.text}`}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {state.kind === 'loading' ? (
        <Card padding="sm">
          <SkeletonTable rows={4} cols={5} label="Загрузка списка снимков" />
        </Card>
      ) : null}

      {state.kind === 'ready' ? (
        <Card padding="none">
          <CardHeader
            title="Снимки"
            count={state.snapshots.length > 0 ? state.snapshots.length : undefined}
          />
          {state.snapshots.length === 0 ? (
            <EmptyState
              title="Снимков пока нет"
              description="Нажмите «Создать бэкап», чтобы сделать первый."
            />
          ) : (
            <Table ariaLabel="Снимки бэкапов">
              <TableHead>
                <tr>
                  <Th>Идентификатор</Th>
                  <Th>Дата</Th>
                  <Th>Хост</Th>
                  <Th>Теги</Th>
                  <Th align="right" width="12rem">
                    Действие
                  </Th>
                </tr>
              </TableHead>
              <TableBody>
                {state.snapshots.map((s) => (
                  <TableRow key={s.id} interactive>
                    <Td className="font-mono text-xs">{s.short_id}</Td>
                    <Td className="text-xs text-ink-3">{formatDate(s.time)}</Td>
                    <Td className="text-xs text-ink-3">{s.hostname}</Td>
                    <Td>
                      {s.tags.length === 0 ? (
                        <span className="text-xs text-ink-3">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {s.tags.map((t) => (
                            <Badge key={t} size="sm">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </Td>
                    <Td align="right">
                      <RestoreSnapshotButton
                        shortId={s.short_id}
                        time={formatDate(s.time)}
                        onRestored={() => void refresh()}
                      />
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      ) : null}
    </>
  );
}
