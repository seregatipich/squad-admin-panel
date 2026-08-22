'use client';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';

interface AuditEntry {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_kind: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  status_code: number | null;
  duration_ms: number | null;
  context: Record<string, unknown>;
  row_hash?: string | null;
  prev_hash?: string | null;
}

interface VerifyChainResult {
  ok: boolean;
  checked: number;
  broken_at: string | null;
  reason: 'prev_hash' | 'row_hash' | null;
}

const POLL_MS = 6000;

export default function AuditPage() {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyChainResult | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  async function verifyChain() {
    setVerifying(true);
    setVerifyErr(null);
    setVerifyResult(null);
    try {
      const r = await fetch('/api/v1/audit/verify-chain', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setVerifyResult((await r.json()) as VerifyChainResult);
    } catch (e) {
      setVerifyErr((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/v1/audit?page=1&page_size=200', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { items: AuditEntry[] };
        if (!cancelled) {
          setItems(j.items);
          setErr(null);
          setLastUpdate(new Date());
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
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (r) =>
        r.action_type.toLowerCase().includes(needle) ||
        (r.target_type ?? '').toLowerCase().includes(needle) ||
        (r.target_id ?? '').toLowerCase().includes(needle) ||
        (r.actor_user_id ?? '').toLowerCase().includes(needle),
    );
  }, [items, q]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Журнал действий</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={verifyChain}
            disabled={verifying}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs hover:bg-neutral-800 disabled:opacity-50"
          >
            {verifying ? 'Проверка…' : 'Проверить цепочку'}
          </button>
          <span className="text-xs text-neutral-500">записей: {items.length}</span>
          <LiveIndicator lastUpdate={lastUpdate} />
        </div>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      {verifyErr ? (
        <output className="block rounded border border-red-900 bg-red-950 p-3 text-sm">
          Проверка цепочки не удалась: {verifyErr}
        </output>
      ) : null}

      {verifyResult ? (
        verifyResult.ok ? (
          <output className="block rounded border border-emerald-900 bg-emerald-950 p-3 text-sm text-emerald-300">
            Цепочка цела: проверено записей — {verifyResult.checked}.
          </output>
        ) : (
          <output className="block rounded border border-red-900 bg-red-950 p-3 text-sm text-red-300">
            Обнаружен разрыв цепочки на записи #{verifyResult.broken_at} ({verifyResult.reason}).
            Проверено до разрыва — {verifyResult.checked}.
          </output>
        )
      ) : null}

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Фильтр по действию, цели или актору…"
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm"
      />

      {rows.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          {items.length ? 'Нет совпадений.' : 'Журнал пуст.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2">Время</th>
                <th className="text-left p-2">Actor</th>
                <th className="text-left p-2">Действие</th>
                <th className="text-left p-2">Цель</th>
                <th className="text-right p-2">Код</th>
                <th className="text-right p-2">ms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr
                    className="border-t border-neutral-900 hover:bg-neutral-950 cursor-pointer"
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  >
                    <td className="p-2 text-neutral-500 text-xs whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="p-2 font-mono text-xs">
                      {r.actor_kind === 'user'
                        ? (r.actor_user_id?.slice(0, 8) ?? '—')
                        : r.actor_kind}
                    </td>
                    <td className="p-2 font-mono">{r.action_type}</td>
                    <td className="p-2 font-mono text-xs text-neutral-400">
                      {r.target_type ? `${r.target_type} ${r.target_id?.slice(0, 12) ?? ''}` : '—'}
                    </td>
                    <td className="p-2 text-right font-mono text-xs">
                      <StatusCode code={r.status_code} />
                    </td>
                    <td className="p-2 text-right font-mono text-xs text-neutral-500">
                      {r.duration_ms ?? '—'}
                    </td>
                  </tr>
                  {expanded === r.id ? (
                    <tr>
                      <td colSpan={6} className="bg-neutral-950 p-3">
                        <pre className="text-[11px] font-mono text-neutral-400 whitespace-pre-wrap break-all">
                          {JSON.stringify(r.context, null, 2)}
                        </pre>
                        {r.row_hash ? (
                          <dl className="mt-2 space-y-0.5 text-[11px] font-mono text-neutral-500 break-all">
                            <div>
                              <span className="text-neutral-500">row_hash: </span>
                              {r.row_hash}
                            </div>
                            <div>
                              <span className="text-neutral-500">prev_hash: </span>
                              {r.prev_hash ?? '—'}
                            </div>
                          </dl>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusCode({ code }: { code: number | null }) {
  if (code == null) return <span className="text-neutral-500">—</span>;
  const tone =
    code < 300
      ? 'text-emerald-400'
      : code < 400
        ? 'text-sky-400'
        : code < 500
          ? 'text-amber-400'
          : 'text-red-400';
  return <span className={tone}>{code}</span>;
}
