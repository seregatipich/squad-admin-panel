'use client';
import { useEffect, useId, useState } from 'react';
import { AlertDialog, Button, InlineBanner, Modal, Textarea } from '@/components/ui';
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
 *
 * Отправку подтверждает `AlertDialog`, а не системный `confirm()`: последний
 * останавливает поток выполнения, не даёт ловушки фокуса и выглядит по-разному
 * в разных браузерах.
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
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const textareaId = useId();

  useEffect(() => {
    if (!target) return;
    setMessage('');
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

  if (!target) return null;

  const trimmed = message.trim();
  const tooShort = trimmed.length < MESSAGE_MIN;

  async function handleSend() {
    if (!target || tooShort || busy) return;
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
      setConfirming(false);
    }
  }

  return (
    <>
      <Modal
        open
        onClose={() => onOpenChange(false)}
        title={`Сообщение отряду «${target.label}»`}
        description="Предупреждение получит каждый, кто сейчас состоит в отряде."
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
              disabled={tooShort}
              loading={busy}
            >
              Отправить
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {pickableTemplates(templates).length > 0 ? (
            <TemplatePicker
              templates={templates}
              context={{ player: target.leaderName ?? undefined }}
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
          </div>

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
        title="Отправить сообщение отряду"
        body={`Отряд «${target.label}» получит: «${trimmed}»`}
        confirmLabel="Отправить сообщение"
        cancelLabel="Отмена"
        tone="default"
        busy={busy}
        onConfirm={() => void handleSend()}
      />
    </>
  );
}
