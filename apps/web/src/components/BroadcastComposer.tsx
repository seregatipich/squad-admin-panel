'use client';
import { useEffect, useId, useState } from 'react';
import { type MessageTemplate, pickableTemplates } from '@/lib/messageTemplates';
import { TemplatePicker } from './TemplatePicker';

// Mirrors the zod body schema on POST /api/v1/servers/:serverId/broadcast
// (apps/api/src/routes/server-messaging.ts).
const BROADCAST_MIN = 2;
const BROADCAST_MAX = 300;

/**
 * Inline composer for sending a server-wide RCON `AdminBroadcast`. Renders
 * nothing when the current user lacks the 'chat' squad permission — callers
 * pass that down as `canChat` (from `GET /api/v1/me`'s `squad_permissions`).
 */
export function BroadcastComposer({ serverId, canChat }: { serverId: string; canChat: boolean }) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const inputId = useId();

  useEffect(() => {
    if (!canChat) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/message-templates', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (res.ok && !cancelled) setTemplates((await res.json()) as MessageTemplate[]);
      } catch {
        // Template list is best-effort — the free-text input still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canChat]);

  if (!canChat) return null;

  const trimmed = message.trim();
  const tooShort = trimmed.length < BROADCAST_MIN;

  async function handleSend() {
    if (tooShort || busy) return;
    if (!confirm(`Отправить объявление всем игрокам на сервере?\n\n"${trimmed}"`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/v1/servers/${serverId}/broadcast`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setFeedback({ kind: 'ok', text: 'Объявление отправлено' });
      setMessage('');
    } catch (err) {
      setFeedback({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Объявление всем игрокам
        </h2>
        {pickableTemplates(templates).length > 0 ? (
          <button
            type="button"
            onClick={() => setShowTemplates((v) => !v)}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            {showTemplates ? 'Скрыть шаблоны' : 'Шаблоны'}
          </button>
        ) : null}
      </div>
      {showTemplates ? (
        <div className="mb-3">
          <TemplatePicker
            templates={templates}
            context={{}}
            onSelect={(text) => {
              setMessage(text.slice(0, BROADCAST_MAX));
              setShowTemplates(false);
            }}
          />
        </div>
      ) : null}
      <div className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          Текст объявления
        </label>
        <input
          id={inputId}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Текст объявления (мин. 2 символа)"
          maxLength={BROADCAST_MAX}
          className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600"
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={tooShort || busy}
          className="rounded bg-sky-600 px-4 py-1.5 text-sm text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Отправка…' : 'Отправить'}
        </button>
      </div>
      {feedback ? (
        <p className={`mt-2 text-xs ${feedback.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {feedback.text}
        </p>
      ) : null}
    </section>
  );
}
