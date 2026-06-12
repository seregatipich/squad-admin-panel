'use client';
import { useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';

const POLL_MS = 30_000;

interface Me {
  player_id: string;
  steam_id64: string | null;
  canonical_name: string;
  avatar_url: string | null;
  permissions: string[];
}

interface ActiveSession {
  id: string;
  ip: string | null;
  user_agent: string | null;
  last_activity_at: string;
  expires_at: string;
  current: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

function formatRelative(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return 'истекла';
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `через ${diffMin} мин`;
  const diffH = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (diffH < 24) return remMin > 0 ? `через ${diffH} ч ${remMin} мин` : `через ${diffH} ч`;
  const diffD = Math.floor(diffH / 24);
  return `через ${diffD} дн`;
}

function shortenUa(ua: string | null): string {
  if (!ua) return '—';
  const m = ua.match(/^([^/]+\/[^\s]+).*\((.*?)\)/);
  return m ? `${m[1]} (${m[2]})` : ua.slice(0, 80);
}

export default function AccountSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, sessRes] = await Promise.all([
          fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/v1/me/sessions', { credentials: 'include', cache: 'no-store' }),
        ]);
        if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
        if (!sessRes.ok) throw new Error(`HTTP ${sessRes.status}`);
        if (cancelled) return;
        setMe((await meRes.json()) as Me);
        setSessions((await sessRes.json()) as ActiveSession[]);
        setLastUpdate(new Date());
      } catch (e) {
        if (!cancelled) setMsg({ kind: 'err', text: (e as Error).message });
      }
    }
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  async function revokeOne(id: string) {
    setBusyId(id);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/me/sessions/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setMsg({ kind: 'ok', text: 'Сессия завершена.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function revokeAll() {
    setRevokingAll(true);
    setMsg(null);
    try {
      const r = await fetch('/api/v1/me/sessions', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      window.location.href = '/login';
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
      setRevokingAll(false);
    }
  }

  async function logout() {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
    window.location.href = '/login';
  }

  if (!me) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Аккаунт</h1>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      {msg ? (
        <div
          className={`rounded border p-3 text-sm ${
            msg.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Профиль</h2>
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
          <dt className="text-neutral-500">Player ID</dt>
          <dd className="font-mono text-xs">{me.player_id}</dd>
          <dt className="text-neutral-500">SteamID64</dt>
          <dd className="font-mono">{me.steam_id64 ?? '—'}</dd>
          <dt className="text-neutral-500">Имя</dt>
          <dd>{me.canonical_name}</dd>
          <dt className="text-neutral-500">Permissions</dt>
          <dd className="font-mono text-xs">{me.permissions.length} ключей</dd>
        </dl>
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Активные сессии</h2>
          <button
            type="button"
            disabled={revokingAll || sessions.length <= 1}
            onClick={revokeAll}
            className="rounded border border-red-900 px-3 py-1 text-xs text-red-400 hover:border-red-700 hover:text-red-300 disabled:opacity-40"
          >
            {revokingAll ? 'Завершаются…' : 'Завершить все'}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-2">IP</th>
                <th className="py-2 pr-2">Устройство</th>
                <th className="py-2 pr-2">Последнее действие</th>
                <th className="py-2 pr-2">Истекает</th>
                <th className="py-2 pr-2"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-t border-neutral-900">
                  <td className="py-2 pr-2 font-mono">{s.ip ?? '—'}</td>
                  <td className="py-2 pr-2 text-neutral-400">{shortenUa(s.user_agent)}</td>
                  <td className="py-2 pr-2 text-neutral-400">{formatDate(s.last_activity_at)}</td>
                  <td className="py-2 pr-2 text-neutral-400">
                    {formatDate(s.expires_at)}{' '}
                    <span className="text-neutral-500 text-xs">
                      ({formatRelative(s.expires_at)})
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-right">
                    {s.current ? (
                      <span className="rounded bg-emerald-950/50 px-2 py-0.5 text-xs text-emerald-300">
                        текущая
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === s.id}
                        onClick={() => revokeOne(s.id)}
                        className="rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                      >
                        {busyId === s.id ? '…' : 'Завершить'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <button
          type="button"
          onClick={logout}
          className="rounded border border-red-900 px-4 py-2 text-sm text-red-400 hover:text-red-300 hover:border-red-700"
        >
          Выйти из панели
        </button>
      </section>
    </div>
  );
}
