'use client';
import { useEffect, useId, useState } from 'react';
import { type MessageTemplate, pickableTemplates } from '@/lib/messageTemplates';
import { TemplatePicker } from './TemplatePicker';

// Mirrors the zod body schema on
// POST /api/v1/servers/:serverId/squads/:squadId/message.
const MESSAGE_MIN = 2;
const MESSAGE_MAX = 300;

export interface SquadMessageTarget {
  serverId: string;
  teamId: number;
  squadId: number;
  label: string;
  /** Squad leader's in-game name, substituted for `{player}` in templates. */
  leaderName: string | null;
}

/**
 * Modal for warning every current member of one squad (RCON `AdminWarn`,
 * one call per player). `target` is null when the modal is closed. Template
 * previews substitute `{player}` with the squad leader's nickname, if known.
 */
export function SquadMessageModal({
  target,
  onOpenChange,
}: {
  target: SquadMessageTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const titleId = useId();
  const textareaId = useId();

  useEffect(() => {
    if (!target) return;
    setMessage('');
    setFeedback(null);
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
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [target, onOpenChange]);

  if (!target) return null;

  const trimmed = message.trim();
  const tooShort = trimmed.length < MESSAGE_MIN;

  async function handleSend() {
    if (!target || tooShort || busy) return;
    if (!confirm(`Отправить сообщение отряду «${target.label}»?\n\n"${trimmed}"`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/v1/servers/${target.serverId}/squads/${target.squadId}/message?team_id=${target.teamId}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: trimmed }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setFeedback({ kind: 'ok', text: 'Сообщение отправлено' });
      setMessage('');
    } catch (err) {
      setFeedback({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={() => onOpenChange(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onOpenChange(false);
      }}
    >
      <div
        className="w-full max-w-md rounded border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <h2 id={titleId} className="mb-3 text-lg font-semibold text-neutral-100">
          Сообщение отряду «{target.label}»
        </h2>

        {pickableTemplates(templates).length > 0 ? (
          <div className="mb-3">
            <TemplatePicker
              templates={templates}
              context={{ player: target.leaderName ?? undefined }}
              onSelect={(text) => setMessage(text.slice(0, MESSAGE_MAX))}
            />
          </div>
        ) : null}

        <label htmlFor={textareaId} className="sr-only">
          Текст сообщения
        </label>
        <textarea
          id={textareaId}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={MESSAGE_MAX}
          rows={3}
          placeholder="Текст сообщения (мин. 2 символа)"
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-500"
        />

        {feedback ? (
          <p
            className={`mt-2 text-xs ${feedback.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}
          >
            {feedback.text}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={tooShort || busy}
            onClick={() => void handleSend()}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Отправка…' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}
