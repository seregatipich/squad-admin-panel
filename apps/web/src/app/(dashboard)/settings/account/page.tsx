'use client';
import { useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';

const POLL_MS = 30_000;

interface Me {
  id: string;
  email: string;
  display_name: string | null;
  permissions: string[];
  clearance: number;
}

interface Provision {
  uri: string;
  manual_entry: string;
  backup_codes: string[];
}

export default function AccountSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [provision, setProvision] = useState<Provision | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [disablePass, setDisablePass] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Me;
        if (!cancelled) {
          setMe(j);
          setLastUpdate(new Date());
        }
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

  async function beginTotp() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/v1/me/totp/provision', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setProvision((await r.json()) as Provision);
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp() {
    setBusy(true);
    try {
      const r = await fetch('/api/v1/me/totp/enable', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ totp_code: totpCode.trim() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      setMsg({ kind: 'ok', text: '2FA включена. Сохраните backup-коды!' });
      setProvision(null);
      setTotpCode('');
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function disableTotp() {
    setBusy(true);
    try {
      const r = await fetch('/api/v1/me/totp/disable', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: disablePass }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setMsg({ kind: 'ok', text: '2FA отключена.' });
      setDisablePass('');
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'include',
    });
    window.location.href = '/login';
  }

  if (!me) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="space-y-6 max-w-2xl">
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
          <dt className="text-neutral-500">Email</dt>
          <dd>{me.email}</dd>
          <dt className="text-neutral-500">Имя</dt>
          <dd>{me.display_name ?? '—'}</dd>
          <dt className="text-neutral-500">Clearance</dt>
          <dd className="font-mono">{me.clearance}</dd>
          <dt className="text-neutral-500">Permissions</dt>
          <dd className="font-mono text-xs">{me.permissions.length} ключей</dd>
        </dl>
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Двухфакторная аутентификация (TOTP)
        </h2>

        {!provision ? (
          <>
            <p className="text-sm text-neutral-400">
              Добавьте ещё один фактор для входа: Google Authenticator, Aegis, 1Password, любое
              TOTP-приложение.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={beginTotp}
              className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
            >
              Подключить 2FA
            </button>

            <div className="border-t border-neutral-800 pt-4 space-y-2">
              <p className="text-sm text-neutral-400">
                Отключить 2FA (нужен пароль для подтверждения):
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={disablePass}
                  onChange={(e) => setDisablePass(e.target.value)}
                  placeholder="Текущий пароль"
                  className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={busy || !disablePass}
                  onClick={disableTotp}
                  className="rounded bg-red-700 px-4 py-2 text-sm text-white hover:bg-red-600 disabled:opacity-40"
                >
                  Отключить
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">1. Отсканируйте QR-код или введите вручную:</p>
            <div className="rounded bg-neutral-900 p-3 font-mono text-xs break-all">
              {provision.manual_entry}
            </div>
            <p className="text-xs text-neutral-500">
              Или откройте otpauth-ссылку на устройстве где стоит TOTP-приложение:
            </p>
            <div className="rounded bg-neutral-900 p-2 font-mono text-[10px] break-all text-neutral-500">
              {provision.uri}
            </div>

            <p className="text-sm pt-2">2. Сохраните backup-коды (каждый работает один раз):</p>
            <div className="grid grid-cols-2 gap-1 font-mono text-xs">
              {provision.backup_codes.map((c) => (
                <div key={c} className="rounded bg-neutral-900 px-2 py-1">
                  {c}
                </div>
              ))}
            </div>

            <p className="text-sm pt-2">3. Введите 6-значный код из приложения:</p>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                className="w-32 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-mono"
              />
              <button
                type="button"
                disabled={busy || totpCode.length !== 6}
                onClick={confirmTotp}
                className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
              >
                Включить
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setProvision(null)}
                className="rounded border border-neutral-800 px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200"
              >
                Отмена
              </button>
            </div>
          </div>
        )}
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
