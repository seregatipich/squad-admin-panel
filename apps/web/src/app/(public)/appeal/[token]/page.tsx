'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

interface AppealStatusView {
  number: number;
  status: string;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

const STATUS_LABELS: Record<string, string> = {
  pending: 'На рассмотрении',
  in_review: 'В работе',
  approved: 'Одобрена',
  rejected: 'Отклонена',
};

const STATUS_CLASSES: Record<string, string> = {
  pending: 'border-amber-900 bg-amber-950 text-amber-200',
  in_review: 'border-sky-900 bg-sky-950 text-sky-200',
  approved: 'border-emerald-900 bg-emerald-950 text-emerald-200',
  rejected: 'border-neutral-700 bg-neutral-900 text-neutral-300',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Applicant-facing status page for one ban appeal (MOD-5, #62), reached only
 * through the tracking token handed out at submission. The panel has no way
 * to notify a banned player — there is no mail channel and an in-game
 * `AdminWarn` cannot reach someone who is banned — so this pull page *is* the
 * decision channel.
 *
 * It renders exactly what `GET /api/v1/public/appeals/:token` returns: number,
 * status, timestamps and the moderator's public reply. An unknown token and
 * somebody else's token are indistinguishable here, as they are in the API.
 */
export default function AppealStatusPage() {
  const params = useParams();
  const rawToken = params?.token;
  const token = typeof rawToken === 'string' ? rawToken : null;

  const [state, setState] = useState<LoadState>('loading');
  const [appeal, setAppeal] = useState<AppealStatusView | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setState('missing');
      return;
    }
    try {
      const res = await fetch(`/api/v1/public/appeals/${encodeURIComponent(token)}`, {
        cache: 'no-store',
      });
      if (res.status === 404) {
        setState('missing');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      setAppeal((await res.json()) as AppealStatusView);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1 border-b border-neutral-900 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Статус апелляции</h1>
        <p className="text-sm text-neutral-400">
          Эта страница доступна только по вашей ссылке. Решение появится здесь.
        </p>
      </header>

      {state === 'loading' ? <p className="text-sm text-neutral-500">Загрузка…</p> : null}

      {state === 'missing' ? (
        <p className="rounded border border-neutral-800 bg-neutral-950 px-4 py-6 text-center text-sm text-neutral-400">
          Апелляция не найдена. Проверьте ссылку.
        </p>
      ) : null}

      {state === 'error' ? (
        <p className="rounded border border-red-900 bg-red-950 p-4 text-sm text-red-200">
          Не удалось загрузить статус апелляции. Попробуйте позже.
        </p>
      ) : null}

      {state === 'ready' && appeal ? (
        <section className="space-y-4 rounded border border-neutral-800 bg-neutral-950 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-lg text-neutral-200">{`#${appeal.number}`}</span>
            <span
              className={`rounded border px-2 py-0.5 text-xs ${
                STATUS_CLASSES[appeal.status] ?? STATUS_CLASSES.pending
              }`}
            >
              {STATUS_LABELS[appeal.status] ?? appeal.status}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Подана</dt>
              <dd className="text-neutral-200">{formatDate(appeal.created_at)}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Решение</dt>
              <dd className="text-neutral-200">{formatDate(appeal.decided_at)}</dd>
            </div>
          </dl>

          {appeal.decision_note ? (
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-neutral-500">
                Ответ администрации
              </div>
              <p className="whitespace-pre-wrap text-sm text-neutral-200">{appeal.decision_note}</p>
            </div>
          ) : (
            <p className="text-xs text-neutral-500">
              Ответ администрации появится здесь после рассмотрения.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
