'use client';

import { useCallback, useEffect, useState } from 'react';
import { getLiveBus } from '@/lib/live-bus';
import {
  availableMarkTypes,
  type MarkTypeOption,
  type PlayerMark,
  partitionMarks,
  severityTone,
} from '@/lib/marks';

const toneClasses: Record<string, string> = {
  red: 'border-red-900 bg-red-950/60 text-red-200',
  amber: 'border-amber-900 bg-amber-950/60 text-amber-200',
  neutral: 'border-neutral-800 bg-neutral-900 text-neutral-200',
};

export function PlayerMarks({ playerId }: { playerId: string }) {
  const [types, setTypes] = useState<MarkTypeOption[]>([]);
  const [marks, setMarks] = useState<PlayerMark[]>([]);
  const [picked, setPicked] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const reload = useCallback(async () => {
    const [typesRes, marksRes] = await Promise.all([
      fetch('/api/v1/mark-types', { credentials: 'include', cache: 'no-store' }),
      fetch(`/api/v1/players/${playerId}/marks?include_cleared=true`, {
        credentials: 'include',
        cache: 'no-store',
      }),
    ]);
    if (typesRes.ok) setTypes((await typesRes.json()) as MarkTypeOption[]);
    if (marksRes.ok) {
      const body = (await marksRes.json()) as { items: PlayerMark[] };
      setMarks(body.items);
    }
  }, [playerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const bus = getLiveBus();
    return bus.subscribe((event) => {
      if (event.type === 'mark_type.changed') void reload();
    });
  }, [reload]);

  const { active, cleared } = partitionMarks(marks);
  const options = availableMarkTypes(types, active);

  async function setMark() {
    if (!picked) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/marks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mark_type_id: Number(picked),
          comment: comment.trim() || undefined,
        }),
      });
      if (res.status === 409) {
        setMsg({ kind: 'err', text: 'Метка этого типа уже стоит.' });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPicked('');
      setComment('');
      await reload();
      setMsg({ kind: 'ok', text: 'Метка поставлена.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function clearMark(mark: PlayerMark) {
    const reason = prompt('Причина снятия метки (необязательно):') ?? undefined;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/marks/${mark.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear_reason: reason }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await reload();
      setMsg({ kind: 'ok', text: 'Метка снята.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">
        Метки подозрения ({active.length})
      </h2>

      {msg ? (
        <div
          className={`rounded border p-2 text-xs ${
            msg.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      {active.length === 0 ? (
        <div className="text-sm text-neutral-500">активных меток нет</div>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {active.map((mark) => (
            <li
              key={mark.id}
              className={`inline-flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                toneClasses[severityTone(mark.mark_type.severity)]
              }`}
            >
              <span className="font-medium">{mark.mark_type.label_ru}</span>
              {mark.comment ? <span className="text-neutral-400">— {mark.comment}</span> : null}
              <button
                type="button"
                onClick={() => clearMark(mark)}
                disabled={busy}
                className="rounded px-1 text-neutral-400 hover:text-neutral-100 disabled:opacity-40"
                aria-label="Снять метку"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
        >
          <option value="">— тип метки —</option>
          {options.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label_ru}
            </option>
          ))}
        </select>
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={512}
          placeholder="комментарий (необязательно)"
          className="flex-1 min-w-[180px] rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={setMark}
          disabled={!picked || busy}
          className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
        >
          Поставить метку
        </button>
      </div>

      {cleared.length > 0 ? (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer">Снятые метки ({cleared.length})</summary>
          <ul className="mt-2 space-y-1">
            {cleared.map((mark) => (
              <li key={mark.id} className="flex flex-wrap gap-2">
                <span className="line-through">{mark.mark_type.label_ru}</span>
                <span>снял: {mark.cleared_by_name ?? '—'}</span>
                {mark.clear_reason ? <span>({mark.clear_reason})</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
