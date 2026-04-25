'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';

const POLL_MS = 30_000;

interface Me {
  steam_id64: string;
  canonical_name: string;
  permissions: string[];
}

interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface CreateResponse extends ApiToken {
  plaintext: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export default function TokensPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<CreateResponse | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const nameInputId = useId();

  const sortedPermissions = useMemo(() => (me ? [...me.permissions].sort() : []), [me]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, tokRes] = await Promise.all([
          fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/v1/me/tokens', { credentials: 'include', cache: 'no-store' }),
        ]);
        if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
        if (!tokRes.ok) throw new Error(`HTTP ${tokRes.status}`);
        if (cancelled) return;
        setMe((await meRes.json()) as Me);
        setTokens((await tokRes.json()) as ApiToken[]);
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

  function toggleScope(key: string) {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setMsg({ kind: 'err', text: 'Укажите имя токена.' });
      return;
    }
    setCreating(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/me/tokens', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          scopes: Array.from(selectedScopes),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${body.error ?? 'unknown'}`);
      }
      const created = (await res.json()) as CreateResponse;
      setJustCreated(created);
      setTokens((prev) => [
        ...prev,
        {
          id: created.id,
          name: created.name,
          scopes: created.scopes,
          last_used_at: null,
          created_at: created.created_at,
          revoked_at: null,
        },
      ]);
      setName('');
      setSelectedScopes(new Set());
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(id: string) {
    if (!confirm('Отозвать токен? Это действие необратимо.')) return;
    setRevokingId(id);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/me/tokens/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTokens((prev) =>
        prev.map((t) => (t.id === id ? { ...t, revoked_at: new Date().toISOString() } : t)),
      );
      setMsg({ kind: 'ok', text: 'Токен отозван.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setRevokingId(null);
    }
  }

  async function copyPlaintext() {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.plaintext);
      setMsg({ kind: 'ok', text: 'Токен скопирован в буфер обмена.' });
    } catch (e) {
      setMsg({ kind: 'err', text: `Не удалось скопировать: ${(e as Error).message}` });
    }
  }

  if (!me) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">API-токены</h1>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      <p className="text-sm text-neutral-400">
        Токены позволяют скриптам и интеграциям обращаться к API панели от вашего имени. Скоупы —
        подмножество ваших прав; если у вас отнимут роль, токен немедленно потеряет соответствующие
        разрешения. Токен показывается полностью только один раз при создании.
      </p>

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

      {justCreated ? (
        <section className="rounded border border-amber-900 bg-amber-950/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-amber-200">
              Сохраните токен сейчас — он больше не будет показан
            </h2>
            <button
              type="button"
              onClick={() => setJustCreated(null)}
              className="text-xs text-amber-300 hover:text-amber-100"
            >
              Скрыть
            </button>
          </div>
          <code className="block break-all rounded bg-neutral-950 px-3 py-2 font-mono text-xs text-amber-200">
            {justCreated.plaintext}
          </code>
          <button
            type="button"
            onClick={copyPlaintext}
            className="rounded border border-amber-700 px-3 py-1 text-xs text-amber-200 hover:bg-amber-900/30"
          >
            Скопировать
          </button>
        </section>
      ) : null}

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Создать токен</h2>
        <form onSubmit={createToken} className="space-y-3">
          <div>
            <label htmlFor={nameInputId} className="mb-1 block text-xs text-neutral-500">
              Имя
            </label>
            <input
              id={nameInputId}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="напр. CI runner, Discord bot"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <fieldset>
            <legend className="mb-1 text-xs text-neutral-500">
              Скоупы ({selectedScopes.size} из {sortedPermissions.length})
            </legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-72 overflow-y-auto rounded border border-neutral-800 bg-neutral-900 p-3">
              {sortedPermissions.length === 0 ? (
                <div className="col-span-2 text-xs text-neutral-500">
                  У вас нет разрешений — токен можно создать только с пустым набором скоупов (только
                  для интроспекции профиля).
                </div>
              ) : (
                sortedPermissions.map((key) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 font-mono text-xs text-neutral-300"
                  >
                    <input
                      type="checkbox"
                      checked={selectedScopes.has(key)}
                      onChange={() => toggleScope(key)}
                    />
                    {key}
                  </label>
                ))
              )}
            </div>
          </fieldset>
          <button
            type="submit"
            disabled={creating}
            className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
          >
            {creating ? 'Создание…' : 'Создать токен'}
          </button>
        </form>
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Существующие</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-2">Имя</th>
                <th className="py-2 pr-2">Скоупы</th>
                <th className="py-2 pr-2">Создан</th>
                <th className="py-2 pr-2">Использован</th>
                <th className="py-2 pr-2">Статус</th>
                <th className="py-2 pr-2"></th>
              </tr>
            </thead>
            <tbody>
              {tokens.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-3 text-center text-xs text-neutral-500">
                    Токенов пока нет.
                  </td>
                </tr>
              ) : (
                tokens.map((t) => (
                  <tr key={t.id} className="border-t border-neutral-900 align-top">
                    <td className="py-2 pr-2">{t.name}</td>
                    <td className="py-2 pr-2">
                      {t.scopes.length === 0 ? (
                        <span className="text-xs text-neutral-500">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {t.scopes.map((s) => (
                            <span
                              key={s}
                              className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">{formatDate(t.created_at)}</td>
                    <td className="py-2 pr-2 text-neutral-400">{formatDate(t.last_used_at)}</td>
                    <td className="py-2 pr-2">
                      {t.revoked_at ? (
                        <span className="rounded bg-red-950/50 px-2 py-0.5 text-xs text-red-300">
                          отозван
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-950/50 px-2 py-0.5 text-xs text-emerald-300">
                          активен
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-right">
                      {t.revoked_at ? null : (
                        <button
                          type="button"
                          disabled={revokingId === t.id}
                          onClick={() => revokeToken(t.id)}
                          className="rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                        >
                          {revokingId === t.id ? '…' : 'Отозвать'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
