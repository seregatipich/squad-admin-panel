'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  AlertDialog,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  PlusIcon,
  SkeletonTable,
  SortableTh,
  type SortDirection,
  StatusDot,
  type StatusState,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { RelativeTime } from './RelativeTime';
import type { ServerRow } from './types';

interface StatusStyle {
  label: string;
  state: StatusState;
}

const SERVER_STATUS: Record<string, StatusStyle> = {
  running: { label: 'Работает', state: 'good' },
  starting: { label: 'Запускается', state: 'warn' },
  stopping: { label: 'Остановка', state: 'warn' },
  installing: { label: 'Установка', state: 'warn' },
  ready: { label: 'Готов', state: 'idle' },
  stopped: { label: 'Остановлен', state: 'idle' },
  pending: { label: 'Ожидает', state: 'idle' },
  failed: { label: 'Сбой', state: 'crit' },
};

const RCON_STATUS: Record<string, StatusStyle> = {
  connected: { label: 'Подключён', state: 'good' },
  authenticating: { label: 'Аутентификация', state: 'warn' },
  reconnecting: { label: 'Переподключение', state: 'warn' },
  disconnected: { label: 'Отключён', state: 'crit' },
  failed: { label: 'Сбой', state: 'crit' },
  not_polled: { label: 'Не опрашивается', state: 'idle' },
};

const SORT_DIRECTION_TEXT: Record<SortDirection, string> = {
  asc: 'по возрастанию',
  desc: 'по убыванию',
};

/** Порядок строк при выбранной колонке; без выбора остаётся порядок ответа API. */
function sortServers(
  servers: ServerRow[],
  key: string | null,
  direction: SortDirection,
): ServerRow[] {
  if (key === null) return servers;
  const sign = direction === 'asc' ? 1 : -1;
  return [...servers].sort((a, b) => {
    if (key === 'players') return sign * ((a.player_count ?? -1) - (b.player_count ?? -1));
    if (key === 'status') return sign * a.status.localeCompare(b.status, 'ru');
    return sign * a.display_name.localeCompare(b.display_name, 'ru');
  });
}

export function ServersTable({
  servers,
  loading,
  error,
  onRefresh,
}: {
  servers: ServerRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [direction, setDirection] = useState<SortDirection>('asc');
  const rows = useMemo(
    () => sortServers(servers, sortKey, direction),
    [servers, sortKey, direction],
  );

  const handleSort = (key: string) => {
    if (key === sortKey) {
      setDirection(direction === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(key);
    setDirection('asc');
  };

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Серверы"
        count={servers.length === 0 ? undefined : servers.length}
        actions={
          <>
            <ButtonLink href="/servers/new" size="sm">
              <PlusIcon />
              Создать
            </ButtonLink>
            <ButtonLink href="/servers" variant="plain" size="sm">
              Все серверы
            </ButtonLink>
          </>
        }
      />
      {error ? (
        <CardBody>
          <InlineBanner
            tone="crit"
            title="Список серверов не загрузился"
            description={error}
            action={
              <Button size="sm" onClick={onRefresh}>
                Повторить
              </Button>
            }
          />
        </CardBody>
      ) : loading ? (
        <CardBody>
          <SkeletonTable rows={4} cols={5} label="Загружаем список серверов" />
        </CardBody>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Серверов нет"
          description="Установите первый сервер — он появится здесь вместе со статусом и числом игроков."
          action={
            <ButtonLink href="/servers/new" variant="primary" size="sm">
              Установить первый
            </ButtonLink>
          }
        />
      ) : (
        <Table ariaLabel="Серверы">
          <TableHead>
            <tr>
              <SortableTh
                sortKey="name"
                activeKey={sortKey}
                direction={direction}
                onSort={handleSort}
                label="Имя"
                directionText={SORT_DIRECTION_TEXT}
              />
              <SortableTh
                sortKey="status"
                activeKey={sortKey}
                direction={direction}
                onSort={handleSort}
                label="Статус"
                directionText={SORT_DIRECTION_TEXT}
              />
              <SortableTh
                sortKey="players"
                activeKey={sortKey}
                direction={direction}
                onSort={handleSort}
                label="Игроки"
                directionText={SORT_DIRECTION_TEXT}
                align="right"
              />
              <Th>RCON</Th>
              <Th>Последний опрос</Th>
              {/*
                Колонок «Карта / слой» и «CPU / RAM» здесь больше нет: обе
                печатали константу («не выбрано» и «— / —») — данных под них
                `/api/v1/servers` не отдаёт. Две колонки, которые никогда ничего
                не сообщают, отнимали ширину у тех, что сообщают.
              */}
              <Th align="right">Действия</Th>
            </tr>
          </TableHead>
          <TableBody>
            {rows.map((s) => (
              <ServerTableRow key={s.id} server={s} onAction={onRefresh} />
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function ServerTableRow({ server, onAction }: { server: ServerRow; onAction: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = SERVER_STATUS[server.status] ?? {
    label: server.status,
    state: 'idle' as StatusState,
  };
  const rcon =
    server.status === 'running'
      ? (RCON_STATUS[server.rcon_state ?? 'not_polled'] ?? {
          label: server.rcon_state ?? 'неизвестно',
          state: 'idle' as StatusState,
        })
      : { label: '—', state: 'idle' as StatusState };
  const players = server.status === 'running' ? `${server.player_count ?? '—'}` : '—';

  async function restart() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/v1/servers/${server.id}/restart`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) {
        setError(r.status === 403 ? 'нет прав' : `ошибка ${r.status}`);
      } else {
        onAction();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  return (
    <TableRow interactive>
      <Td>
        <Link href={`/servers/${server.id}`} className="block min-w-0 no-underline">
          <span className="block truncate font-medium text-ink">{server.display_name}</span>
          <span className="block truncate text-2xs text-ink-3">{server.slug}</span>
        </Link>
      </Td>
      <Td>
        <StatusDot state={status.state} label={status.label} size="sm" />
      </Td>
      <Td numeric>{players}</Td>
      <Td>
        <StatusDot state={rcon.state} label={rcon.label} size="sm" />
      </Td>
      <Td className="text-xs text-ink-3">
        {server.last_poll_at ? <RelativeTime ts={server.last_poll_at} /> : '—'}
      </Td>
      <Td align="right">
        <div className="inline-flex items-center gap-1">
          <ButtonLink href={`/servers/${server.id}`} size="sm">
            Открыть
          </ButtonLink>
          <Button
            size="sm"
            loading={busy}
            onClick={() => setConfirmOpen(true)}
            disabled={server.status !== 'running'}
            title={
              server.status !== 'running'
                ? 'Доступно только для работающих серверов'
                : 'Перезапустить контейнер'
            }
          >
            Перезапуск
          </Button>
        </div>
        {error ? (
          <span role="alert" className="mt-1 block text-2xs text-crit">
            {error}
          </span>
        ) : null}
        {/*
          Перезапуск отключает игроков, но ничего не стирает, поэтому тон
          обычный: критический цвет кнопки дизайн-система оставляет за
          необратимым разрушением данных (§5).
        */}
        <AlertDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Перезапустить сервер"
          body={`«${server.display_name}» перезапустится, все игроки будут отключены. Сохранённые данные не пострадают.`}
          confirmLabel="Перезапустить"
          cancelLabel="Отмена"
          tone="default"
          busy={busy}
          onConfirm={restart}
        />
      </Td>
    </TableRow>
  );
}
