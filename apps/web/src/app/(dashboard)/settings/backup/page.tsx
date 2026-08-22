'use client';
import { useCallback, useEffect, useState } from 'react';
import { BackupTriggerButton } from '@/components/BackupTriggerButton';
import { LiveIndicator } from '@/components/LiveIndicator';
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

const POLL_MS = 30_000;

interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  paths: string[];
  tags: string[];
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

export default function BackupPage() {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/host/backups', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 403) {
        setState({ kind: 'forbidden' });
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { detail?: string };
        setState({ kind: 'error', text: j.detail ?? `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as { snapshots: Snapshot[] };
      setState({ kind: 'ready', snapshots: body.snapshots });
      setLastUpdate(new Date());
    } catch (e) {
      setState({ kind: 'error', text: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <PageHeader
        title="Бэкапы"
        subtitle="Резервные копии Postgres и Redis снимаются восстановимыми логическими дампами (pg_dump + RDB) и хранятся в зашифрованном restic-репозитории. Ежедневный снимок делается по расписанию; здесь можно снять внеочередной бэкап или восстановить панель из выбранного снимка."
        status={<LiveIndicator lastUpdate={lastUpdate} />}
        actions={
          <BackupTriggerButton
            disabled={state.kind === 'forbidden'}
            disabledReason="Нет прав на управление хостом"
            onBackedUp={() => void load()}
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
            <Button size="sm" onClick={() => void load()}>
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
                        onRestored={() => void load()}
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
