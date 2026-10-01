'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertDialog,
  Button,
  Checkbox,
  FieldRow,
  IconButton,
  InlineBanner,
  Modal,
  Select,
  Textarea,
} from '@/components/ui';
import { ApiError, apiFetch, apiSend } from '@/lib/api';
import { type MessageTemplate, pickableTemplates } from '@/lib/messageTemplates';
import { TemplatePicker } from './TemplatePicker';

// Mirrors the zod body schema on
// POST /api/v1/servers/:serverId/players/:playerId/message. The 300-char cap is
// the worker's BROADCAST_MAX_CHARS, asserted again when AdminWarn is built.
const MESSAGE_MIN = 2;
const MESSAGE_MAX = 300;

/** Russian texts for the machine error codes of `POST /api/v1/servers/:id/players/:id/message`. */
const SEND_ERROR_MESSAGES: Record<string, string> = {
  forbidden: 'Недостаточно прав для отправки сообщений',
  player_not_found: 'Игрок не найден',
  player_not_addressable: 'Игрока нельзя адресовать: неизвестен его идентификатор в игре',
  message_failed: 'Не удалось доставить сообщение на сервер',
};

function describeSendError(code: string | undefined, status: number): string {
  return (code && SEND_ERROR_MESSAGES[code]) ?? `Не удалось отправить сообщение (HTTP ${status})`;
}

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const serverSelectId = useId();

  const needsServerPick = target != null && target.serverId === null;
  // Черновик сбрасывается по тому, кому адресовано сообщение, а не по ссылке на
  // `target`: родители (живой состав с секундным тикером) передают новый
  // объект на каждом рендере, и сброс по ссылке стирал бы ввод каждую секунду.
  const targetKey = target ? `${target.serverId ?? ''}:${target.playerId}` : null;

  useEffect(() => {
    if (targetKey === null) return;
    setMessage('');
    setLogToCard(false);
    setSelectedServerId('');
    setFeedback(null);
    setConfirming(false);
    let cancelled = false;
    void (async () => {
      try {
        const list = await apiFetch<MessageTemplate[]>('/api/v1/message-templates');
        if (!cancelled) setTemplates(list);
      } catch {
        // Template list is best-effort — the free-text input still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetKey]);

  useEffect(() => {
    if (!needsServerPick) return;
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ items?: ServerOption[] }>('/api/v1/servers');
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
      await apiSend(`/api/v1/servers/${serverId}/players/${target.playerId}/message`, {
        method: 'POST',
        json: { message: trimmed, log_to_card: logToCard },
      });
      setFeedback({ kind: 'ok', text: 'Сообщение отправлено' });
      setMessage('');
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.jsonBody<{ error?: string }>();
        setFeedback({ kind: 'err', text: describeSendError(body?.error, err.status) });
      } else {
        setFeedback({ kind: 'err', text: (err as Error).message });
      }
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
              onSelect={(text) => {
                setMessage(text.slice(0, MESSAGE_MAX));
                // Текст уезжает в поле ниже: фокус переводит туда и взгляд, и
                // курсор, чтобы выбранную заготовку сразу можно было
                // дописать, а не искать, куда она подставилась.
                textareaRef.current?.focus();
              }}
            />
          ) : null}

          <div>
            <label htmlFor={textareaId} className="sr-only">
              Текст сообщения
            </label>
            <Textarea
              ref={textareaRef}
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
  variant = 'text',
}: {
  playerId: string | null;
  name: string;
  canChat: boolean;
  serverId?: string | null;
  className?: string;
  /**
   * `icon` — значок-конверт для плотных строк (ростер): подпись живёт в
   * `aria-label` и подсказке. `className` в этом варианте не применяется.
   */
  variant?: 'text' | 'icon';
}) {
  const [open, setOpen] = useState(false);

  if (!canChat || !playerId) return null;

  const label = `Сообщение игроку: ${name}`;

  return (
    <>
      {variant === 'icon' ? (
        <IconButton
          size="sm"
          icon={<span aria-hidden="true">✉</span>}
          label={label}
          onClick={() => setOpen(true)}
        />
      ) : className ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={label}
          className={className}
        >
          Сообщение
        </button>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)} aria-label={label}>
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
