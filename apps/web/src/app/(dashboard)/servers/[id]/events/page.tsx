'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';

interface Event {
  stream_id: string;
  event_id: string;
  type: string;
  ts: string;
  payload: unknown;
}

interface EventsResponse {
  items: Event[];
  total: number;
}

const POLL_MS = 4000;

export default function EventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [events, setEvents] = useState<Event[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/v1/servers/${id}/events?limit=200`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!cancelled) {
          setEvents(((await r.json()) as EventsResponse).items);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  const types = Array.from(new Set(events.map((e) => e.type))).sort();
  const filtered = typeFilter === 'all' ? events : events.filter((e) => e.type === typeFilter);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/servers/${id}`} className="text-sky-400 hover:text-sky-300 text-xs font-mono">
          ← сервер
        </Link>
        <h1 className="text-2xl font-semibold">События сервера</h1>
        <span className="text-xs text-neutral-500 font-mono">{id}</span>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <div className="flex flex-wrap gap-1 text-xs">
        <button
          type="button"
          onClick={() => setTypeFilter('all')}
          className={`rounded px-2 py-1 font-mono ${
            typeFilter === 'all' ? 'bg-sky-700 text-white' : 'bg-neutral-900 text-neutral-400'
          }`}
        >
          all ({events.length})
        </button>
        {types.map((t) => {
          const count = events.filter((e) => e.type === t).length;
          return (
            <button
              type="button"
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`rounded px-2 py-1 font-mono ${
                typeFilter === t ? 'bg-sky-700 text-white' : 'bg-neutral-900 text-neutral-400'
              }`}
            >
              {t} ({count})
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          Нет событий. События появляются когда сервер работает — RCON connect, player
          connect/disconnect, match start/end.
        </div>
      ) : (
        <ul className="rounded border border-neutral-800 bg-neutral-950 divide-y divide-neutral-900">
          {filtered.map((ev) => (
            <li key={ev.stream_id} className="p-3 space-y-1">
              <div className="flex items-baseline gap-3 text-xs">
                <span className="text-neutral-500 font-mono w-40">
                  {new Date(ev.ts).toLocaleString()}
                </span>
                <span className="font-mono text-sky-400">{ev.type}</span>
                <span className="text-neutral-600 font-mono text-[10px]">{ev.event_id}</span>
              </div>
              {ev.payload && Object.keys(ev.payload as object).length > 0 ? (
                <pre className="text-[11px] text-neutral-400 font-mono whitespace-pre-wrap break-all bg-neutral-900 rounded p-2">
                  {JSON.stringify(ev.payload, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
