'use client';

// Sources and their wire codes come from the shared table, never a local copy:
// a hand-copied list once lacked config-sync, whose entries then vanished as
// soon as any source box was unchecked (#781).
import { LOG_SOURCES, type LogSource, sourceCode } from '@squad/shared-config/log-stream';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Checkbox,
  EmptyState,
  SearchField,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const DEFAULT_LEVEL: Level = 'info';

/** Тон пилюли только дублирует уровень, написанный в ней же словом. */
const LEVEL_TONE: Record<Level, BadgeTone> = {
  error: 'crit',
  warn: 'warn',
  info: 'good',
  debug: 'neutral',
};

/*
 * Ссылка на выгрузку остаётся обычным `<a download>`, а не `ButtonLink`:
 * `next/link` перехватывает клик и уводит в клиентскую навигацию, из-за чего
 * файл не скачивается. Классы повторяют вторичную кнопку размера `sm` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

interface Entry {
  id: string;
  ts: number;
  source: string;
  level: Level;
  serverId?: string;
  msg: string;
  ctx?: Record<string, unknown>;
}

interface LogsResponse {
  entries: Entry[];
  /** Newest stream id the API scanned, before filtering; the next `after=`. */
  cursor?: string;
}

interface ServersResponse {
  items: Array<{ id: string; display_name: string }>;
}

export function LogList(props: { servers: Array<{ id: string; display_name: string }> }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [src, setSrc] = useState<Set<string>>(new Set(LOG_SOURCES));
  const [lvl, setLvl] = useState<Level>(DEFAULT_LEVEL);
  const [srv, setSrv] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const lastIdRef = useRef<string | null>(null);

  const buildUrl = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams();
      if (src.size > 0 && src.size < LOG_SOURCES.length) {
        const codes = Array.from(src).map((s) => sourceCode(s as LogSource));
        if (codes.length) p.set('src', codes.join(','));
      }
      p.set('lvl', lvl);
      if (srv) p.set('srv', srv);
      if (q) p.set('q', q);
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      return `/api/v1/logs?${p.toString()}`;
    },
    [src, lvl, srv, q],
  );

  useEffect(() => {
    setEntries([]);
    setLoaded(false);
    lastIdRef.current = null;
    const controller = new AbortController();
    void (async () => {
      try {
        const r = await fetch(buildUrl(), { credentials: 'include', signal: controller.signal });
        if (!r.ok) return;
        const body = (await r.json()) as LogsResponse;
        setEntries(body.entries);
        setLoaded(true);
        // The API cursor exists even when nothing matched the filter, so the
        // tail starts on an empty first page too.
        lastIdRef.current = body.cursor ?? body.entries[0]?.id ?? null;
      } catch {
        // swallowed (likely AbortError)
      }
    })();
    return () => controller.abort();
  }, [buildUrl]);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const after = lastIdRef.current;
      if (!after) return;
      try {
        const r = await fetch(buildUrl({ after }), { credentials: 'include' });
        if (!r.ok) return;
        const body = (await r.json()) as LogsResponse;
        // Advance over everything scanned, matched or not: advancing only on
        // matches re-read the same filtered-out window every second.
        lastIdRef.current = body.cursor ?? body.entries[0]?.id ?? after;
        if (body.entries.length === 0) return;
        setEntries((prev) => [...body.entries, ...prev].slice(0, 1000));
      } catch {
        // ignore transient errors
      }
    }, 1000);
    return () => clearInterval(t);
  }, [buildUrl, paused]);

  const toggleSrc = (s: string, on: boolean) => {
    const next = new Set(src);
    if (on) next.add(s);
    else next.delete(s);
    setSrc(next);
  };

  const toggleExpand = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const filtered =
    q !== '' || srv !== '' || lvl !== DEFAULT_LEVEL || src.size !== LOG_SOURCES.length;

  const resetFilters = () => {
    setSrc(new Set(LOG_SOURCES));
    setLvl(DEFAULT_LEVEL);
    setSrv('');
    setQ('');
  };

  // Слоты собираются один раз и раздаются обоим вариантам панели: сброс в
  // `Toolbar` — пара «обработчик + подпись», и типом запрещено передать одну
  // половину пары, поэтому вариант с ним и без него — это два разных вызова.
  const toolbarSlots = {
    search: (
      <SearchField
        value={q}
        onCommit={setQ}
        placeholder="Поиск по сообщению…"
        label="Поиск по записям"
        clearLabel="Очистить поиск"
      />
    ),
    filters: (
      <>
        <Select
          value={lvl}
          onChange={(e) => setLvl(e.target.value as Level)}
          aria-label="Минимальный уровень"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              ≥ {l}
            </option>
          ))}
        </Select>
        <Select value={srv} onChange={(e) => setSrv(e.target.value)} aria-label="Сервер">
          <option value="">Все серверы</option>
          {props.servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.display_name}
            </option>
          ))}
        </Select>
      </>
    ),
    actions: (
      <>
        <Button size="sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? 'Возобновить' : 'Пауза'}
        </Button>
        <a href="/api/v1/logs/export" download className={DOWNLOAD_LINK_CLASS}>
          Экспорт
        </a>
      </>
    ),
  };

  return (
    <div className="space-y-4">
      {filtered ? (
        <Toolbar {...toolbarSlots} onReset={resetFilters} resetLabel="Сбросить фильтры" />
      ) : (
        <Toolbar {...toolbarSlots} />
      )}

      <fieldset>
        <legend className="text-2xs uppercase tracking-[0.06em] text-ink-3">Источники</legend>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          {LOG_SOURCES.map((s) => (
            <Checkbox
              key={s}
              label={s}
              checked={src.has(s)}
              onChange={(e) => toggleSrc(s, e.target.checked)}
            />
          ))}
        </div>
      </fieldset>

      <Card padding="none">
        {!loaded && entries.length === 0 ? (
          <div className="p-4">
            <SkeletonTable rows={10} cols={5} label="Записи загружаются" />
          </div>
        ) : entries.length === 0 ? (
          filtered ? (
            <EmptyState
              variant="filtered"
              title="Ничего не нашлось"
              description="Под текущие фильтры не подходит ни одна запись."
              action={
                <Button size="sm" onClick={resetFilters}>
                  Сбросить фильтры
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Записей нет"
              description="Коннекторы панели ещё ничего не записали."
            />
          )
        ) : (
          <Table dense layout="fixed" maxHeight="68vh" ariaLabel="Логи панели">
            <TableHead>
              <TableRow>
                <Th width="7rem">Время</Th>
                <Th width="5.5rem">Уровень</Th>
                <Th width="7rem">Источник</Th>
                <Th width="8rem">Сервер</Th>
                <Th>Сообщение</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((e) => {
                const open = expanded.has(e.id);
                const detailId = `log-detail-${e.id}`;
                return (
                  <Fragment key={e.id}>
                    <TableRow interactive>
                      <Td className="whitespace-nowrap font-mono text-xs tabular-nums text-ink-3">
                        {new Date(e.ts).toISOString().slice(11, 23)}
                      </Td>
                      <Td>
                        <Badge tone={LEVEL_TONE[e.level]} size="sm">
                          {e.level}
                        </Badge>
                      </Td>
                      <Td truncate className="font-mono text-xs text-ink-2">
                        {e.source}
                      </Td>
                      <Td truncate className="font-mono text-xs text-ink-3">
                        {e.serverId ? e.serverId.slice(0, 8) : '—'}
                      </Td>
                      {/* Раскрывается только запись с контекстом: кнопка, которая
                          ничего не открывает, врёт и скринридеру, и указателю.
                          Раскрытие живёт в ячейке, а не в `onClick` на строке —
                          до строки не добраться с клавиатуры. */}
                      {e.ctx ? (
                        <Td className="p-0!">
                          <button
                            type="button"
                            onClick={() => toggleExpand(e.id)}
                            aria-expanded={open}
                            aria-controls={detailId}
                            className="flex h-7 w-full items-center px-3 text-left font-mono transition-colors hover:text-accent"
                          >
                            <span className="truncate">{e.msg}</span>
                          </button>
                        </Td>
                      ) : (
                        <Td truncate className="font-mono">
                          {e.msg}
                        </Td>
                      )}
                    </TableRow>
                    {open && e.ctx ? (
                      <tr id={detailId}>
                        <td colSpan={5} className="bg-raised/40 px-3 py-3">
                          <pre className="whitespace-pre-wrap break-all font-mono text-2xs text-ink-2">
                            {JSON.stringify(e.ctx, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

export type { ServersResponse };
