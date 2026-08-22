'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  PlusIcon,
  SearchField,
  Select,
  SkeletonTable,
  StatusDot,
  type StatusState,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { formatSeedProgress, type SeedingSummary } from './seeding-format';

interface Server {
  id: string;
  display_name: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at: string;
  rcon_state: string | null;
  player_count: number | null;
  last_poll_at: string | null;
  tags?: string[];
  seeding: SeedingSummary | null;
}

interface ServersResponse {
  items: Server[];
  total: number;
}

const POLL_MS = 120_000;

/**
 * Состояние сервера словами. Точка состояния красит строку, но смысл несёт
 * подпись: правило «никогда только цветом» (§5 дизайн-системы) действует и
 * внутри таблицы. Неизвестное значение показывается как есть — так новый
 * статус из API виден оператору, а не превращается в пустую ячейку.
 */
const STATUS_LABEL: Record<string, string> = {
  pending: 'ожидает',
  installing: 'установка',
  ready: 'готов',
  starting: 'запускается',
  running: 'работает',
  stopping: 'останавливается',
  stopped: 'остановлен',
  failed: 'ошибка',
};

const STATUS_STATE: Record<string, StatusState> = {
  running: 'good',
  failed: 'crit',
  starting: 'warn',
  stopping: 'warn',
  installing: 'warn',
};

/** Состояние соединения RCON. Само слово «RCON» — технический идентификатор. */
const RCON_LABEL: Record<string, string> = {
  connected: 'подключён',
  disconnected: 'отключён',
};

const ACTION_LABEL = {
  start: 'Пуск',
  stop: 'Стоп',
  restart: 'Рестарт',
} as const;

export default function ServersPage() {
  const [data, setData] = useState<ServersResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  /**
   * Признак «этот ответ уже никому не нужен» приходит параметром, а не живёт
   * в замыкании эффекта: тот же запрос запускает и кнопка «Повторить», у
   * которой отменять нечего.
   */
  const loadServers = useCallback(async (isStale: () => boolean = () => false) => {
    try {
      const r = await fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ServersResponse;
      if (!isStale()) {
        setData(j);
        setErr(null);
        setLastUpdate(new Date());
      }
    } catch (e) {
      if (!isStale()) setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isStale = () => cancelled;
    void loadServers(isStale);
    const t = setInterval(() => {
      void loadServers(isStale);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [loadServers]);

  const onStatus = useCallback((event: { data: { server_id: string; status: string } }) => {
    setData((prev) => {
      if (!prev) return prev;
      const idx = prev.items.findIndex((s) => s.id === event.data.server_id);
      if (idx < 0) return prev;
      const items = prev.items.slice();
      items[idx] = { ...items[idx], status: event.data.status };
      return { ...prev, items };
    });
    setLastUpdate(new Date());
  }, []);
  useLiveSubscription('server.status', onStatus);

  const onDeleted = useCallback((event: { data: { server_id: string } }) => {
    setData((prev) => {
      if (!prev) return prev;
      const items = prev.items.filter((s) => s.id !== event.data.server_id);
      if (items.length === prev.items.length) return prev;
      return { items, total: items.length };
    });
    setLastUpdate(new Date());
  }, []);
  useLiveSubscription('server.deleted', onDeleted);

  const onRcon = useCallback(
    (event: { data: { server_id: string; state: string; player_count?: number } }) => {
      setData((prev) => {
        if (!prev) return prev;
        const idx = prev.items.findIndex((s) => s.id === event.data.server_id);
        if (idx < 0) return prev;
        const items = prev.items.slice();
        items[idx] = {
          ...items[idx],
          rcon_state: event.data.state,
          player_count:
            event.data.player_count != null ? event.data.player_count : items[idx].player_count,
        };
        return { ...prev, items };
      });
      setLastUpdate(new Date());
    },
    [],
  );
  useLiveSubscription('rcon.status', onRcon);

  const onSeeding = useCallback(
    (event: {
      data: {
        server_id: string;
        state: 'seeding' | 'live';
        current_players: number;
        live_at: number;
        progress_pct: number;
        started_at: string | null;
      };
    }) => {
      setData((prev) => {
        if (!prev) return prev;
        const idx = prev.items.findIndex((s) => s.id === event.data.server_id);
        if (idx < 0) return prev;
        const items = prev.items.slice();
        items[idx] = {
          ...items[idx],
          seeding: {
            state: event.data.state,
            current_players: event.data.current_players,
            live_at: event.data.live_at,
            progress_pct: event.data.progress_pct,
            started_at: event.data.started_at,
          },
        };
        return { ...prev, items };
      });
      setLastUpdate(new Date());
    },
    [],
  );
  useLiveSubscription('server.seeding', onSeeding);

  const allTags = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.items.flatMap((s) => s.tags ?? [])));
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    let filtered = data.items;
    if (tagFilter) {
      filtered = filtered.filter((s) => (s.tags ?? []).includes(tagFilter));
    }
    const needle = q.trim().toLowerCase();
    if (!needle) return filtered;
    return filtered.filter(
      (s) =>
        s.display_name.toLowerCase().includes(needle) ||
        s.slug.toLowerCase().includes(needle) ||
        s.id.toLowerCase().includes(needle),
    );
  }, [data, q, tagFilter]);

  async function runAction(id: string, action: 'start' | 'stop' | 'restart') {
    setActingId(`${id}:${action}`);
    try {
      const r = await fetch(`/api/v1/servers/${id}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok)
        setErr(
          `Не удалось выполнить «${ACTION_LABEL[action]}»: HTTP ${r.status} ${await r.text()}`,
        );
    } finally {
      setActingId(null);
    }
  }

  const filtered = q.trim() !== '' || tagFilter !== null;
  const resetFilters = () => {
    setQ('');
    setTagFilter(null);
  };

  const searchField = (
    <SearchField
      value={q}
      onCommit={setQ}
      label="Поиск серверов"
      placeholder="Поиск по имени, идентификатору или ID…"
      clearLabel="Очистить поиск"
    />
  );

  const tagSelect =
    allTags.length > 0 ? (
      <Select
        aria-label="Фильтр по тегу"
        value={tagFilter ?? ''}
        onChange={(e) => setTagFilter(e.target.value || null)}
      >
        <option value="">Все теги</option>
        {allTags.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </Select>
    ) : undefined;

  const summary = data ? `Показано: ${rows.length} из ${data.total}` : undefined;

  return (
    <PageContainer>
      <PageHeader
        title="Серверы"
        status={<LiveIndicator lastUpdate={lastUpdate} />}
        actions={
          <ButtonLink href="/servers/new" variant="primary">
            <PlusIcon />
            Установить новый
          </ButtonLink>
        }
      />

      {err && (
        <InlineBanner
          tone="crit"
          title="Не удалось получить список серверов"
          description={err}
          action={
            <Button
              onClick={() => {
                void loadServers();
              }}
            >
              Повторить
            </Button>
          }
        />
      )}

      {filtered ? (
        <Toolbar
          search={searchField}
          filters={tagSelect}
          summary={summary}
          onReset={resetFilters}
          resetLabel="Сбросить фильтры"
        />
      ) : (
        <Toolbar search={searchField} filters={tagSelect} summary={summary} />
      )}

      {!data ? (
        /* Список не загрузился — под полосой ошибки не место приглашению
           «установите первый сервер»: серверы, возможно, есть. */
        err ? null : (
          <SkeletonTable rows={6} cols={6} label="Загружается список серверов" />
        )
      ) : rows.length === 0 ? (
        <Card>
          {data?.items.length ? (
            <EmptyState
              variant="filtered"
              title="Ничего не нашлось"
              description="По текущему запросу и фильтру подходящих серверов нет."
              action={<Button onClick={resetFilters}>Сбросить фильтры</Button>}
            />
          ) : (
            <EmptyState
              title="Серверов пока нет"
              description="Установите первый Squad-сервер — он появится в этом списке."
              action={
                <ButtonLink href="/servers/new" variant="primary">
                  Установить новый
                </ButtonLink>
              }
            />
          )}
        </Card>
      ) : (
        <Card padding="none">
          <Table ariaLabel="Серверы">
            <TableHead>
              <tr>
                <Th>Состояние</Th>
                <Th>Имя</Th>
                <Th align="right">Игроков</Th>
                <Th>RCON</Th>
                <Th>Последний опрос</Th>
                <Th>Действия</Th>
              </tr>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} interactive>
                  <Td>
                    <StatusDot
                      state={STATUS_STATE[row.status] ?? 'idle'}
                      label={STATUS_LABEL[row.status] ?? row.status}
                      size="sm"
                    />
                  </Td>
                  <Td>
                    <Link
                      href={`/servers/${row.id}`}
                      className="font-medium text-accent no-underline"
                    >
                      {row.display_name}
                    </Link>
                    <div className="font-mono text-2xs text-ink-3">{row.slug}</div>
                    {(row.tags ?? []).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(row.tags ?? []).map((tag) => (
                          <Badge key={tag} size="sm">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td numeric>
                    {row.player_count == null ? '—' : row.player_count}
                    {row.seeding?.state === 'seeding' && (
                      <div className="mt-1 flex items-center justify-end gap-1.5">
                        <Badge tone="warn" size="sm">
                          Сидинг
                        </Badge>
                        <span className="text-2xs text-ink-3">
                          {formatSeedProgress(row.seeding.current_players, row.seeding.live_at)}
                        </span>
                      </div>
                    )}
                  </Td>
                  <Td>
                    {row.rcon_state ? (
                      <StatusDot
                        state={row.rcon_state === 'connected' ? 'good' : 'idle'}
                        label={RCON_LABEL[row.rcon_state] ?? row.rcon_state}
                        size="sm"
                      />
                    ) : (
                      <span className="text-xs text-ink-3">—</span>
                    )}
                  </Td>
                  <Td className="text-xs text-ink-3">
                    {row.last_poll_at ? new Date(row.last_poll_at).toLocaleTimeString() : '—'}
                  </Td>
                  <Td>
                    <ActionButtons
                      status={row.status}
                      id={row.id}
                      actingKey={actingId}
                      run={runAction}
                    />
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </PageContainer>
  );
}

function ActionButtons({
  status,
  id,
  actingKey,
  run,
}: {
  status: string;
  id: string;
  actingKey: string | null;
  run: (id: string, action: 'start' | 'stop' | 'restart') => void;
}) {
  const canStart = status !== 'running' && status !== 'starting' && status !== 'installing';
  const canStop = status === 'running' || status === 'starting';
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        disabled={!canStart || !!actingKey}
        loading={actingKey === `${id}:start`}
        onClick={() => run(id, 'start')}
      >
        {ACTION_LABEL.start}
      </Button>
      <Button
        size="sm"
        disabled={!canStop || !!actingKey}
        loading={actingKey === `${id}:stop`}
        onClick={() => run(id, 'stop')}
      >
        {ACTION_LABEL.stop}
      </Button>
      <Button
        size="sm"
        disabled={!canStop || !!actingKey}
        loading={actingKey === `${id}:restart`}
        onClick={() => run(id, 'restart')}
      >
        {ACTION_LABEL.restart}
      </Button>
      <ButtonLink href={`/servers/${id}`} size="sm" variant="plain">
        Открыть
      </ButtonLink>
    </div>
  );
}
