'use client';

import { useEffect, useState } from 'react';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setError(params.get('error'));
    setSteamId(params.get('steam_id64'));
    (async () => {
      const res = await fetch('/api/v1/me', { credentials: 'include' });
      if (res.ok) {
        window.location.href = '/dashboard';
      }
    })();
  }, []);

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-6 p-6 text-neutral-100">
      <h1 className="text-center text-2xl font-semibold">Squad Admin Panel</h1>
      {error === 'auth_failed' && (
        <p className="rounded border border-amber-700/50 bg-amber-950/40 p-3 text-sm text-amber-300">
          Не удалось проверить вход через Steam. Попробуйте ещё раз.
        </p>
      )}
      {error === 'not_authorized' && (
        <p className="rounded border border-rose-700/50 bg-rose-950/40 p-3 text-sm text-rose-300">
          Steam ID <code className="font-mono">{steamId ?? '—'}</code> не имеет доступа к панели.
          Обратитесь к администратору.
        </p>
      )}
      <a
        href="/api/v1/auth/steam/login"
        className="flex w-full items-center justify-center gap-2 rounded-md border border-[#66c0f4] bg-[#1b2838] px-6 py-3 text-white transition hover:bg-[#2a475e]"
      >
        Войти через Steam
      </a>
      <p className="text-center text-xs text-neutral-500">
        Steam OpenID 2.0 — единственный способ входа.
      </p>
    </main>
  );
}
