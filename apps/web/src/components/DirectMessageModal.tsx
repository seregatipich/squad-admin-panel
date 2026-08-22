'use client';
import { useEffect, useId, useState } from 'react';
import {
  AlertDialog,
  Button,
  Checkbox,
  FieldRow,
  InlineBanner,
  Modal,
  Select,
  Textarea,
} from '@/components/ui';
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
 *
 * Отправку подтверждает `AlertDialog`, а не системный `confirm()`: последний
 * останавливает поток выполнения, не даёт ловушки фокуса и выглядит по-разному
 * в разных браузерах.
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
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const textareaId = useId();
  const serverSelectId = useId();

  const needsServerPick = target != null && target.serverId === null;

  useEffect(() => {
    if (!target) return;
    setMessage('');
    setLogToCard(false);
    setSelectedServerId('');
    setFeedback(null);
    setConfirming(false);
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

  if (!target) return null;

  const trimmed = message.trim();
  const tooShort = trimmed.length < MESSAGE_MIN;
  const serverId = target.serverId ?? (selectedServerId || null);

  async function handleSend() {
    if (!target || tooShort || busy || !serverId) return;
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
      setConfirming(false);
    }
  }

  return (
    <>
      <Modal
        open
        onClose={() => onOpenChange(false)}
        title={`Сообщение игроку «${target.playerName}»`}
        closeLabel="Закрыть"
        dismissible={trimmed.length === 0 && !busy}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Отмена
            </Button>
            <Button
              variant="primary"
              onClick={() => setConfirming(true)}
              disabled={tooShort || !serverId}
              loading={busy}
            >
              Отправить
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {needsServerPick ? (
            <FieldRow label="Сервер" htmlFor={serverSelectId}>
              <Select
                id={serverSelectId}
                value={selectedServerId}
                onChange={(e) => setSelectedServerId(e.target.value)}
              >
                <option value="">— выберите сервер —</option>
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.display_name}
                  </option>
                ))}
              </Select>
            </FieldRow>
          ) : null}

          {pickableTemplates(templates).length > 0 ? (
            <TemplatePicker
              templates={templates}
              context={{ player: target.playerName }}
              onSelect={(text) => setMessage(text.slice(0, MESSAGE_MAX))}
            />
          ) : null}

          <div>
            <label htmlFor={textareaId} className="sr-only">
              Текст сообщения
            </label>
            <Textarea
              id={textareaId}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={MESSAGE_MAX}
              rows={3}
              placeholder="Текст сообщения (мин. 2 символа)"
            />
            <p className="mt-1 text-right text-xs tabular-nums text-ink-3">
              {trimmed.length}/{MESSAGE_MAX}
            </p>
          </div>

          <Checkbox
            label="Записать в карточку"
            checked={logToCard}
            onChange={(e) => setLogToCard(e.target.checked)}
          />

          {feedback ? (
            <InlineBanner
              tone={feedback.kind === 'ok' ? 'good' : 'crit'}
              title={feedback.kind === 'ok' ? feedback.text : 'Сообщение не отправлено'}
              description={feedback.kind === 'ok' ? undefined : feedback.text}
            />
          ) : null}
        </div>
      </Modal>

      <AlertDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Отправить сообщение игроку"
        body={`Игрок «${target.playerName}» получит: «${trimmed}»`}
        confirmLabel="Отправить сообщение"
        cancelLabel="Отмена"
        tone="default"
        busy={busy}
        onConfirm={() => void handleSend()}
      />
    </>
  );
}

/**
 * Permission-gated «Сообщение» trigger that owns the modal's open state, so a
 * call site adds exactly one JSX line. Renders nothing without the Squad
 * `chat` permission or for a roster entry that never resolved to a panel
 * player (`playerId` null).
 *
 * @param className Собственное оформление кнопки. Нужно строке живого состава,
 *   где действие ужато до 24px, а примитив кнопки начинается с 28px; там, где
 *   его не передали, кнопка берётся из дизайн-системы.
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
      {className ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Сообщение игроку: ${name}`}
          className={className}
        >
          Сообщение
        </button>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)} aria-label={`Сообщение игроку: ${name}`}>
          Сообщение
        </Button>
      )}
      <DirectMessageModal
        target={open ? { serverId, playerId, playerName: name } : null}
        onOpenChange={setOpen}
      />
    </>
  );
}
