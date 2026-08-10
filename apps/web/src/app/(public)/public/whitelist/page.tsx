'use client';

import { useCallback, useEffect, useState } from 'react';

const STEAM_ID64_RE = /^\d{17}$/;

type PortalState = 'loading' | 'open' | 'closed' | 'error';

/**
 * Public, no-session whitelist/VIP application portal (WL-3, #67). Reads the
 * open/closed master switch from `/api/v1/public/whitelist/settings` and, when
 * open, lets any visitor submit one pending application per SteamID64 via
 * `POST /api/v1/public/whitelist/applications`. No login, no PII beyond the
 * submitted SteamID64 and contact string.
 */
export default function PublicWhitelistPage() {
  const [state, setState] = useState<PortalState>('loading');
  const [steamId64, setSteamId64] = useState('');
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/public/whitelist/settings', { cache: 'no-store' });
      if (!res.ok) {
        setState('error');
        return;
      }
      const data = (await res.json()) as { enabled: boolean };
      setState(data.enabled ? 'open' : 'closed');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!STEAM_ID64_RE.test(steamId64.trim())) {
      setError('Укажите корректный SteamID64 (17 цифр).');
      return;
    }
    if (!body.trim()) {
      setError('Опишите заявку.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/whitelist/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          steam_id64: steamId64.trim(),
          body: body.trim(),
          contact: contact.trim() || undefined,
        }),
      });
      if (res.status === 201) {
        setSubmitted(true);
        setSteamId64('');
        setBody('');
        setContact('');
        return;
      }
      if (res.status === 404) {
        setState('closed');
        return;
      }
      if (res.status === 409) {
        setError('Заявка с этим SteamID64 уже на рассмотрении.');
        return;
      }
      if (res.status === 400) {
        setError('Проверьте правильность заполнения полей.');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(`Не удалось отправить заявку: ${data.error ?? res.status}`);
    } catch (err) {
      setError(`Ошибка сети: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1 border-b border-neutral-900 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Заявка на whitelist / VIP</h1>
        <p className="text-sm text-neutral-400">
          Оставьте заявку на добавление в whitelist. Заявку рассмотрят администраторы.
        </p>
      </header>

      {state === 'loading' ? <p className="text-sm text-neutral-500">Загрузка…</p> : null}

      {state === 'error' ? (
        <p className="rounded border border-red-900 bg-red-950 p-4 text-sm text-red-200">
          Не удалось загрузить портал заявок. Попробуйте позже.
        </p>
      ) : null}

      {state === 'closed' ? (
        <p className="rounded border border-neutral-800 bg-neutral-950 px-4 py-6 text-center text-sm text-neutral-400">
          Приём заявок сейчас закрыт.
        </p>
      ) : null}

      {state === 'open' && submitted ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 p-4 text-sm text-emerald-200">
          Заявка отправлена. Спасибо! Мы свяжемся с вами после рассмотрения.
        </div>
      ) : null}

      {state === 'open' && !submitted ? (
        <form
          onSubmit={submit}
          className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-950 p-5"
        >
          {error ? (
            <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <label className="block text-sm">
            <span className="mb-1 block text-neutral-400">SteamID64</span>
            <input
              type="text"
              inputMode="numeric"
              value={steamId64}
              onChange={(e) => setSteamId64(e.target.value)}
              placeholder="76561198000000000"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-neutral-400">Сообщение</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              maxLength={2000}
              placeholder="Расскажите о себе: сколько играете, за что хотите whitelist…"
              className="w-full resize-y rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-neutral-400">Контакт (необязательно)</span>
            <input
              type="text"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              maxLength={128}
              placeholder="Discord, Steam-профиль…"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-md border border-sky-700 bg-sky-950 px-4 py-2 text-sm text-sky-200 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Отправляем…' : 'Отправить заявку'}
          </button>
        </form>
      ) : null}
    </div>
  );
}
