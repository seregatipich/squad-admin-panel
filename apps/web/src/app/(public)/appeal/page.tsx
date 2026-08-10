'use client';

import { useState } from 'react';

const STEAM_ID64_RE = /^\d{17}$/;
const BODY_MIN = 20;
const BODY_MAX = 4000;
const CONTACT_MAX = 200;

interface SubmittedAppeal {
  number: number;
  tracking_token: string;
}

/**
 * Public, no-session ban-appeal portal (MOD-5, #62). A banned player cannot
 * hold a panel session, so this page submits straight to the anonymous
 * `POST /api/v1/public/appeals` with no auth of any kind.
 *
 * The tracking link shown after a successful submission is the applicant's
 * only handle on their appeal — the API returns the token exactly once — so
 * it is rendered prominently and paired with an explicit "save this link".
 */
export default function PublicAppealPage() {
  const [steamId64, setSteamId64] = useState('');
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedAppeal | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!STEAM_ID64_RE.test(steamId64.trim())) {
      setError('Укажите корректный SteamID64 (17 цифр).');
      return;
    }
    if (body.trim().length < BODY_MIN) {
      setError(`Опишите ситуацию — не менее ${BODY_MIN} символов.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/appeals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          steam_id64: steamId64.trim(),
          body: body.trim(),
          contact: contact.trim() || undefined,
        }),
      });
      if (res.status === 201) {
        setSubmitted((await res.json()) as SubmittedAppeal);
        return;
      }
      if (res.status === 409) {
        setError('Апелляция с этим SteamID64 уже на рассмотрении.');
        return;
      }
      if (res.status === 429) {
        setError('Слишком много заявок с этого адреса. Попробуйте завтра.');
        return;
      }
      if (res.status === 400) {
        setError('Проверьте правильность заполнения полей.');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(`Не удалось отправить апелляцию: ${data.error ?? res.status}`);
    } catch (err) {
      setError(`Ошибка сети: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1 border-b border-neutral-900 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Апелляция на бан</h1>
        <p className="text-sm text-neutral-400">
          Если вы считаете, что бан выдан по ошибке, опишите ситуацию. Заявку рассмотрят
          администраторы вручную — автоматического снятия бана нет.
        </p>
      </header>

      {submitted ? (
        <div className="space-y-3 rounded border border-emerald-900 bg-emerald-950 p-4 text-sm text-emerald-200">
          <p>Апелляция №{submitted.number} отправлена.</p>
          <p className="text-emerald-300/90">
            Сохраните эту ссылку — по ней и только по ней вы узнаете решение:
          </p>
          <p className="break-all rounded border border-emerald-900/60 bg-emerald-950/60 px-3 py-2 font-mono text-xs">
            {`/appeal/${submitted.tracking_token}`}
          </p>
        </div>
      ) : (
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
            <span className="mb-1 block text-neutral-400">Апелляция</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              maxLength={BODY_MAX}
              placeholder="Опишите, почему бан стоит пересмотреть: что произошло, когда, что вы об этом думаете…"
              className="w-full resize-y rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-neutral-400">Контакт (необязательно)</span>
            <input
              type="text"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              maxLength={CONTACT_MAX}
              placeholder="Discord, Steam-профиль…"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-md border border-sky-700 bg-sky-950 px-4 py-2 text-sm text-sky-200 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Отправляем…' : 'Отправить апелляцию'}
          </button>
        </form>
      )}
    </div>
  );
}
