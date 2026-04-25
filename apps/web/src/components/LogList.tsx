'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const SOURCE_LIST = ['bridge', 'rcon', 'log-ingest', 'worker', 'depot', 'install', 'api'] as const;
const SOURCE_CODES: Record<(typeof SOURCE_LIST)[number], string> = {
  bridge: 'B',
  rcon: 'R',
  'log-ingest': 'L',
  worker: 'W',
  depot: 'D',
  install: 'I',
  api: 'A',
};

interface Entry {
  id: string;
  ts: number;
  source: string;
  level: Level;
  serverId?: string;
  msg: string;
  ctx?: Record<string, unknown>;
}

interface ServersResponse {
  items: Array<{ id: string; display_name: string }>;
}

export function LogList(props: { servers: Array<{ id: string; display_name: string }> }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [src, setSrc] = useState<Set<string>>(new Set(SOURCE_LIST));
  const [lvl, setLvl] = useState<Level>('info');
  const [srv, setSrv] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const lastIdRef = useRef<string | null>(null);

  const buildUrl = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams();
      if (src.size > 0 && src.size < SOURCE_LIST.length) {
        const codes = Array.from(src)
          .map((s) => SOURCE_CODES[s as (typeof SOURCE_LIST)[number]])
          .filter(Boolean);
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
    lastIdRef.current = null;
    const controller = new AbortController();
    void (async () => {
      try {
        const r = await fetch(buildUrl(), { credentials: 'include', signal: controller.signal });
        if (!r.ok) return;
        const body = (await r.json()) as { entries: Entry[] };
        setEntries(body.entries);
        if (body.entries.length > 0) lastIdRef.current = body.entries[0]?.id ?? null;
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
        const body = (await r.json()) as { entries: Entry[] };
        if (body.entries.length === 0) return;
        lastIdRef.current = body.entries[0]?.id ?? after;
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {SOURCE_LIST.map((s) => (
          <label key={s} className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={src.has(s)}
              onChange={(e) => toggleSrc(s, e.target.checked)}
            />{' '}
            {s}
          </label>
        ))}
        <select
          value={lvl}
          onChange={(e) => setLvl(e.target.value as Level)}
          className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5"
          aria-label="Минимальный уровень"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              ≥ {l}
            </option>
          ))}
        </select>
        <select
          value={srv}
          onChange={(e) => setSrv(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5"
          aria-label="Сервер"
        >
          <option value="">все серверы</option>
          {props.servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.display_name}
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="поиск…"
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5"
          aria-label="Поиск"
        />
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
          aria-pressed={paused}
        >
          {paused ? 'Возобновить' : 'Пауза'}
        </button>
        <a
          href="/api/v1/logs/export"
          className="ml-auto rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
          download
        >
          ⤓ Экспорт
        </a>
      </div>
      <ul className="space-y-0.5 font-mono text-xs">
        {entries.length === 0 ? (
          <li className="py-4 text-center text-neutral-500">нет записей</li>
        ) : (
          entries.map((e) => (
            <li
              key={e.id}
              className="flex cursor-pointer items-start gap-2 border-b border-neutral-900 py-0.5"
            >
              <button
                type="button"
                onClick={() => toggleExpand(e.id)}
                className="flex w-full items-start gap-2 text-left"
              >
                <span className="text-neutral-500">
                  {new Date(e.ts).toISOString().slice(11, 23)}
                </span>
                <LevelPill level={e.level} />
                <span className="w-20 shrink-0 text-neutral-400">{e.source}</span>
                <span className="w-32 shrink-0 truncate text-neutral-500">
                  {e.serverId ? e.serverId.slice(0, 8) : ''}
                </span>
                <span className="flex-1">
                  {e.msg}
                  {expanded.has(e.id) && e.ctx ? (
                    <pre className="mt-1 whitespace-pre-wrap text-neutral-500">
                      {JSON.stringify(e.ctx, null, 2)}
                    </pre>
                  ) : null}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function LevelPill({ level }: { level: Level }) {
  const cls =
    level === 'error'
      ? 'bg-red-900 text-red-200'
      : level === 'warn'
        ? 'bg-amber-900 text-amber-200'
        : level === 'info'
          ? 'bg-emerald-900 text-emerald-200'
          : 'bg-neutral-800 text-neutral-400';
  return <span className={`shrink-0 rounded px-1 ${cls}`}>{level.toUpperCase()}</span>;
}

export type { ServersResponse };
