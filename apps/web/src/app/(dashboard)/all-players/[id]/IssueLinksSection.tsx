'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface LinkedIssue {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'in_progress' | 'closed';
  created_at: string;
}

interface LinkedIssuesResponse {
  open_count: number;
  items: LinkedIssue[];
}

const STATE_LABELS: Record<LinkedIssue['state'], string> = {
  open: 'Открыт',
  in_progress: 'В работе',
  closed: 'Закрыт',
};

const STATE_BADGE_CLASSES: Record<LinkedIssue['state'], string> = {
  open: 'bg-emerald-950/50 text-emerald-300 border border-emerald-900',
  in_progress: 'bg-amber-950/50 text-amber-300 border border-amber-900',
  closed: 'bg-neutral-800 text-neutral-400 border border-neutral-700',
};

/**
 * «Связанные тикеты» on the player card (ISSUE-3, #156) — the reverse of the
 * ticket card's link block. `GET /api/v1/players/:playerId/issues` is
 * `panel_access`-gated, so the section self-hides on 401/403 rather than
 * consulting a capability flag; it also hides when the player has no unclosed
 * linked ticket, keeping the card free of empty boxes.
 */
export function IssueLinksSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<LinkedIssuesResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHidden(false);
    setError(null);
    fetch(`/api/v1/players/${playerId}/issues`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as LinkedIssuesResponse;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  if (hidden) return null;

  if (error) {
    return (
      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Связанные тикеты</h2>
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка загрузки связанных тикетов: {error}
        </div>
      </section>
    );
  }

  if (!data || data.items.length === 0) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">
        Связанные тикеты
        <span className="ml-2 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 tabular-nums">
          {data.open_count}
        </span>
      </h2>
      <ul className="space-y-1">
        {data.items.map((issue) => (
          <li
            key={issue.id}
            className="flex items-center gap-2 rounded border border-neutral-900 bg-neutral-900/40 px-3 py-1.5 text-sm"
          >
            <span className="font-mono text-xs text-neutral-500">#{issue.number}</span>
            <Link href={`/issues/${issue.id}`} className="text-sky-400 hover:text-sky-300">
              {issue.title}
            </Link>
            <span
              className={`ml-auto rounded px-2 py-0.5 text-[11px] ${STATE_BADGE_CLASSES[issue.state]}`}
            >
              {STATE_LABELS[issue.state]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
