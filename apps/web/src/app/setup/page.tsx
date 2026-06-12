'use client';
import { useEffect, useState } from 'react';

interface SetupStatus {
  setup_completed: boolean;
  first_owner_claimed: boolean;
}

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/setup/status', { credentials: 'include', cache: 'no-store' })
      .then((r) => r.json())
      .then((s: SetupStatus) => {
        if (s.setup_completed) {
          window.location.href = '/';
          return;
        }
        setStatus(s);
      })
      .catch(() => setErr('Не удалось загрузить статус.'));
  }, []);

  async function complete() {
    if (!orgName.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/v1/setup/complete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_name: orgName.trim() }),
      });
      if (r.status === 410) {
        window.location.href = '/';
        return;
      }
      if (r.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      window.location.href = '/';
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!status && !err) return <div className="text-neutral-500 p-8">Загрузка…</div>;

  if (!status?.first_owner_claimed) {
    return (
      <main className="mx-auto mt-24 max-w-md space-y-6 p-6 text-neutral-100">
        <h1 className="text-center text-2xl font-semibold">Настройка панели</h1>
        <p className="text-sm text-neutral-400 text-center">
          Для начала работы войдите через Steam. Первый вошедший автоматически станет Owner.
        </p>
        <a
          href="/api/v1/auth/steam/login"
          className="flex w-full items-center justify-center gap-2 rounded-md border border-[#66c0f4] bg-[#1b2838] px-6 py-3 text-white transition hover:bg-[#2a475e]"
        >
          Войти через Steam
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto mt-24 max-w-md space-y-6 p-6 text-neutral-100">
      <h1 className="text-center text-2xl font-semibold">Настройка панели</h1>
      <p className="text-sm text-neutral-400 text-center">
        Укажите название вашего сообщества или организации.
      </p>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {err}
        </div>
      ) : null}

      <div className="space-y-3">
        <label className="block">
          <span className="text-xs uppercase tracking-widest text-neutral-400">
            Название организации
          </span>
          <input
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Мой Squad-сервер"
            maxLength={100}
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={complete}
          disabled={busy || !orgName.trim()}
          className="w-full rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
        >
          {busy ? 'Сохраняется…' : 'Завершить настройку'}
        </button>
      </div>
    </main>
  );
}
