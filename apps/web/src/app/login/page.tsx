'use client';

import { useEffect, useState } from 'react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needTotp, setNeedTotp] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/v1/me', { credentials: 'include' });
      if (res.ok) {
        window.location.href = '/dashboard';
        return;
      }
      if (res.status === 401) {
        await fetch('/api/v1/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          credentials: 'include',
        });
      }
    })();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          totp_code: totp || undefined,
          remember_me: rememberMe,
        }),
      });
      if (res.ok) {
        window.location.href = '/dashboard';
        return;
      }
      const body = await res.json().catch(() => ({ error: `http_${res.status}` }));
      if (body.error === 'totp_required') {
        setNeedTotp(true);
        setError('Введите 6-значный код из Authenticator');
      } else {
        setError(body.error ?? 'Ошибка входа');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-6 p-6">
      <h1 className="text-center text-2xl font-semibold">Вход</h1>
      <form onSubmit={submit} className="space-y-3">
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 p-2"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 p-2"
          placeholder="Пароль"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {needTotp && (
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 tracking-widest font-mono"
            placeholder="000000"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
          />
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
          />
          Запомнить меня
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-sky-600 p-2 text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </main>
  );
}
