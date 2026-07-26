'use client';
import { useEffect, useId, useState } from 'react';
import { type MessageTemplate, pickableTemplates } from '@/lib/messageTemplates';
import { TemplatePicker } from './TemplatePicker';

// Mirrors the zod body schema on
// POST /api/v1/servers/:serverId/players/:playerId/message. The 300-char cap is
// the worker's BROADCAST_MAX_CHARS, asserted again when AdminWarn is built.
const MESSAGE_MIN = 2;
const MESSAGE_MAX = 300;

interface ServerOption {
  id: string;
  display_name: string;
}

export interface DirectMessageTarget {
  /** Known on the live roster; null on the player card, which then shows a server select. */
  serverId: string | null;
  playerId: string;
  playerName: string;
}

/**
 * Modal for sending one addressed in-game message (RCON `AdminWarn`) to a
 * single player. `target` is null when the modal is closed. When
 * `target.serverId` is null the modal loads the server list and requires the
 * moderator to pick one before sending. `Записать в карточку` additionally
 * stores the message in the addressee's chat history.
 */
export function DirectMessageModal({
  target,
  onOpenChange,
}: {
  target: DirectMessageTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [message, setMessage] = useState('');
  const [logToCard, setLogToCard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const titleId = useId();
  const textareaId = useId();
  const serverSelectId = useId();
  const logToCardId = useId();

  const needsServerPick = target != null && target.serverId === null;

  useEffect(() => {
    if (!target) return;
    setMessage('');
    setLogToCard(false);
    setSelectedServerId('');
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
    if (!needsServerPick) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { items?: ServerOption[] };
        if (body.items && !cancelled) setServers(body.items);
      } catch {
        // Without the list the select stays empty and send stays disabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsServerPick]);

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
  const serverId = target.serverId ?? (selectedServerId || null);

  async function handleSend() {
    if (!target || tooShort || busy || !serverId) return;
    if (!confirm(`Отправить сообщение игроку «${target.playerName}»?\n\n"${trimmed}"`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/v1/servers/${serverId}/players/${target.playerId}/message`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: trimmed, log_to_card: logToCard }),
      });
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
          Сообщение игроку «{target.playerName}»
        </h2>

        {needsServerPick ? (
          <div className="mb-3">
            <label htmlFor={serverSelectId} className="mb-1 block text-xs text-neutral-400">
              Сервер
            </label>
            <select
              id={serverSelectId}
              value={selectedServerId}
              onChange={(e) => setSelectedServerId(e.target.value)}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
            >
              <option value="">— выберите сервер —</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.display_name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {pickableTemplates(templates).length > 0 ? (
          <div className="mb-3">
            <TemplatePicker
              templates={templates}
              context={{ player: target.playerName }}
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
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600"
        />
        <p className="mt-1 text-right text-xs text-neutral-500">
          {trimmed.length}/{MESSAGE_MAX}
        </p>

        <label
          htmlFor={logToCardId}
          className="mt-2 flex items-center gap-2 text-xs text-neutral-300"
        >
          <input
            id={logToCardId}
            type="checkbox"
            checked={logToCard}
            onChange={(e) => setLogToCard(e.target.checked)}
            className="rounded border-neutral-700 bg-neutral-900"
          />
          Записать в карточку
        </label>

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
            disabled={tooShort || busy || !serverId}
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

/**
 * Permission-gated «Сообщение» trigger that owns the modal's open state, so a
 * call site adds exactly one JSX line. Renders nothing without the Squad
 * `chat` permission or for a roster entry that never resolved to a panel
 * player (`playerId` null).
 */
export function DirectMessageButton({
  playerId,
  name,
  canChat,
  serverId = null,
  className,
}: {
  playerId: string | null;
  name: string;
  canChat: boolean;
  serverId?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  if (!canChat || !playerId) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Сообщение игроку: ${name}`}
        className={
          className ??
          'rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-700'
        }
      >
        Сообщение
      </button>
      <DirectMessageModal
        target={open ? { serverId, playerId, playerName: name } : null}
        onOpenChange={setOpen}
      />
    </>
  );
}
