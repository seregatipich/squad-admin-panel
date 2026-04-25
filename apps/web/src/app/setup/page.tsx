'use client';

import { useEffect, useState } from 'react';

interface CheckEnvResponse {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export default function SetupPage() {
  const [envCheck, setEnvCheck] = useState<CheckEnvResponse | null>(null);
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/v1/setup/check-env');
        if (res.status === 410) {
          window.location.href = '/login';
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setEnvCheck((await res.json()) as CheckEnvResponse);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/setup/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: orgName, slug: slug || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = '/login';
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl p-8 space-y-8 text-neutral-100">
      <h1 className="text-2xl font-semibold">Первичная настройка панели</h1>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Шаг 1. Проверка окружения</h2>
        {!envCheck ? (
          <p className="text-sm text-neutral-400">Проверяем…</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {Object.entries(envCheck.checks).map(([k, v]) => (
              <li key={k}>
                <span className={v.ok ? 'text-emerald-400' : 'text-rose-400'}>
                  {v.ok ? '✓' : '✗'}
                </span>{' '}
                <code className="font-mono">{k}</code>
                {v.detail ? <span className="text-neutral-400"> — {v.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Шаг 2. Создать организацию</h2>
        <label className="block">
          <span className="block text-sm text-neutral-400">Название</span>
          <input
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2"
            placeholder="Squad Community"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-sm text-neutral-400">Slug (опционально)</span>
          <input
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 font-mono"
            placeholder="auto"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            pattern="[a-z0-9][a-z0-9-]{0,63}"
          />
        </label>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={busy || !orgName || !envCheck?.ok}
          className="rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? 'Создаётся…' : 'Создать и перейти к логину'}
        </button>
        <p className="pt-2 text-xs text-neutral-500">
          После создания организации откроется страница входа. Первый, кто войдёт через Steam,
          станет Owner&apos;ом панели.
        </p>
      </section>
    </main>
  );
}
