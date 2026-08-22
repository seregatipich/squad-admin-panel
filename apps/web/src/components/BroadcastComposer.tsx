'use client';
import { useEffect, useId, useState } from 'react';
import {
  AlertDialog,
  Button,
  Card,
  CardBody,
  CardHeader,
  InlineBanner,
  TextInput,
} from '@/components/ui';
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
 *
 * Объявление уходит всем игрокам сервера и отменить его нельзя, поэтому отправку
 * подтверждает `AlertDialog` с полным текстом: системный `confirm()` не даёт ни
 * ловушки фокуса, ни возврата фокуса на кнопку, а его вид зависит от браузера.
 */
export function BroadcastComposer({ serverId, canChat }: { serverId: string; canChat: boolean }) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
      setConfirming(false);
    }
  }

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Объявление всем игрокам"
        actions={
          pickableTemplates(templates).length > 0 ? (
            <Button variant="plain" size="sm" onClick={() => setShowTemplates((v) => !v)}>
              {showTemplates ? 'Скрыть шаблоны' : 'Шаблоны'}
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-3">
        {showTemplates ? (
          <TemplatePicker
            templates={templates}
            context={{}}
            onSelect={(text) => {
              setMessage(text.slice(0, BROADCAST_MAX));
              setShowTemplates(false);
            }}
          />
        ) : null}
        <div className="flex gap-2">
          <div className="flex-1">
            <label htmlFor={inputId} className="sr-only">
              Текст объявления
            </label>
            <TextInput
              id={inputId}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Текст объявления (мин. 2 символа)"
              maxLength={BROADCAST_MAX}
            />
          </div>
          <Button
            variant="primary"
            onClick={() => setConfirming(true)}
            disabled={tooShort}
            loading={busy}
          >
            Отправить
          </Button>
        </div>
        {feedback ? (
          <InlineBanner
            tone={feedback.kind === 'ok' ? 'good' : 'crit'}
            title={feedback.kind === 'ok' ? feedback.text : 'Объявление не отправлено'}
            description={feedback.kind === 'ok' ? undefined : feedback.text}
          />
        ) : null}
      </CardBody>

      <AlertDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Отправить объявление"
        body={`Объявление увидят все игроки на сервере: «${trimmed}»`}
        confirmLabel="Отправить объявление"
        cancelLabel="Отмена"
        tone="default"
        busy={busy}
        onConfirm={() => void handleSend()}
      />
    </Card>
  );
}
