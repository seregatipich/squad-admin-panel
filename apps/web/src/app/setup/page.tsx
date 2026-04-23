'use client';

import { useState } from 'react';

interface CheckEnvResponse {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export default function SetupPage() {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [envCheck, setEnvCheck] = useState<CheckEnvResponse | null>(null);
  const [orgName, setOrgName] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [encryptionKeySaved, setEncryptionKeySaved] = useState(false);

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/setup/check-env');
      if (!res.ok) throw new Error(await res.text());
      setEnvCheck(await res.json());
      setStep(1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createOrg = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/setup/org', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: orgName }),
      });
      if (!res.ok) throw new Error(await res.text());
      setStep(2);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createOwner = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/setup/owner', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, display_name: displayName, password }),
      });
      if (!res.ok) throw new Error(await res.text());
      setStep(3);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finalize = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/setup/finalize', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      window.location.href = '/login';
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl p-8 space-y-6">
      <h1 className="text-2xl font-semibold">Squad Admin Panel — установка</h1>
      <ol className="flex gap-2 text-sm text-neutral-400">
        {['Проверка окружения', 'Организация', 'Владелец', 'Готово'].map((label, idx) => (
          <li
            key={label}
            className={
              idx === step ? 'text-sky-400 font-medium' : idx < step ? 'text-emerald-400' : ''
            }
          >
            {idx + 1}. {label}
          </li>
        ))}
      </ol>
      {error && (
        <div className="rounded border border-red-700 bg-red-900/30 p-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {step === 0 && (
        <section className="space-y-4">
          <p>
            Проверим что на хосте есть поддерживаемый Linux, установлен{' '}
            <code>panel-host-bridge</code>, и можно продолжать.
          </p>
          <button
            type="button"
            onClick={runCheck}
            disabled={busy}
            className="rounded bg-sky-600 px-4 py-2 text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? 'Проверяю…' : 'Проверить окружение'}
          </button>
        </section>
      )}
      {step === 1 && envCheck && (
        <section className="space-y-4">
          <ul className="space-y-1 text-sm">
            {Object.entries(envCheck.checks).map(([k, v]) => (
              <li key={k} className={v.ok ? 'text-emerald-400' : 'text-red-400'}>
                {v.ok ? '✅' : '❌'} <b>{k}</b> — {v.detail ?? ''}
              </li>
            ))}
          </ul>
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-900 p-2"
            placeholder="Название сообщества (Squad Community)"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
          />
          <button
            type="button"
            onClick={createOrg}
            disabled={busy || orgName.length < 2}
            className="rounded bg-sky-600 px-4 py-2 text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Далее
          </button>
        </section>
      )}
      {step === 2 && (
        <section className="space-y-4">
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-900 p-2"
            placeholder="email@community.com"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-900 p-2"
            placeholder="Отображаемое имя"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-900 p-2"
            placeholder="Пароль (≥12 символов)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            onClick={createOwner}
            disabled={
              busy || password.length < 12 || !email.includes('@') || displayName.length < 1
            }
            className="rounded bg-sky-600 px-4 py-2 text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Создать владельца
          </button>
        </section>
      )}
      {step === 3 && (
        <section className="space-y-4">
          <p>
            Владелец создан. Убедитесь что <code>APP_ENCRYPTION_KEY</code> сохранён в надёжном месте
            (без него после перезапуска нельзя расшифровать RCON-пароли).
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={encryptionKeySaved}
              onChange={(e) => setEncryptionKeySaved(e.target.checked)}
            />
            <span>APP_ENCRYPTION_KEY сохранён в .env и в моём менеджере паролей</span>
          </label>
          <button
            type="button"
            onClick={finalize}
            disabled={busy || !encryptionKeySaved}
            className="rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Завершить установку и перейти ко входу
          </button>
        </section>
      )}
    </main>
  );
}
